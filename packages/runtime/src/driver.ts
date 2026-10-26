import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Pool, type PoolClient } from "pg";
export type Value = string | number | null;
export interface Driver {
  readonly dialect: "sqlite" | "postgres";
  query<T extends object>(sql: string, values?: readonly Value[]): Promise<T[]>;
  transaction<T>(fn: (connection: Driver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export class SqliteDriver implements Driver {
  readonly dialect = "sqlite" as const;
  private db: DatabaseSync;
  private tail: Promise<void> = Promise.resolve();
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  private direct<T extends object>(
    sql: string,
    values: readonly Value[] = [],
  ): Promise<T[]> {
    return Promise.resolve(
      this.db
        .prepare(
          sql.replace(/\$(\d+)/g, (_match, index: string) => "?" + index),
        )
        .all(...values) as T[],
    );
  }
  query<T extends object>(
    sql: string,
    values: readonly Value[] = [],
  ): Promise<T[]> {
    return this.exclusive(() => this.direct<T>(sql, values));
  }
  transaction<T>(fn: (connection: Driver) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      const connection: Driver = {
        dialect: this.dialect,
        query: <R extends object>(sql: string, values?: readonly Value[]) =>
          this.direct<R>(sql, values),
        transaction: () =>
          Promise.reject(new Error("Nested transaction unsupported")),
        close: () =>
          Promise.reject(new Error("Transaction does not own the connection")),
      };
      try {
        const result = await fn(connection);
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  close(): Promise<void> {
    return this.exclusive(async () => {
      this.db.close();
    });
  }
}
export class PostgresDriver implements Driver {
  readonly dialect = "postgres" as const;
  private pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      application_name: "actionledger",
    });
    // A network reset on a checked-out or idle pg client must not crash the process.
    this.pool.on("connect", (client) => client.on("error", () => undefined));
    this.pool.on("error", () => undefined);
  }
  async query<T extends object>(
    sql: string,
    values: readonly Value[] = [],
  ): Promise<T[]> {
    return (await this.pool.query(sql, [...values])).rows as T[];
  }
  async transaction<T>(fn: (connection: Driver) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      const connection: Driver = {
        dialect: this.dialect,
        query: async <R extends object>(
          sql: string,
          values: readonly Value[] = [],
        ) => (await client.query(sql, [...values])).rows as R[],
        transaction: () =>
          Promise.reject(new Error("Nested transaction unsupported")),
        close: () =>
          Promise.reject(new Error("Transaction does not own the connection")),
      };
      const result = await fn(connection);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      discard = true;
      try {
        await client.query("ROLLBACK");
      } catch {
        /* connection may already be gone */
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}
