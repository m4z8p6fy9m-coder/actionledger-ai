import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Ledger,
  PaymentInput,
  hash,
  MAX_EXPORT_ACTIONS,
} from "@actionledger/core";
let ledger: Ledger;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "actionledger-query-"));
  ledger = new Ledger(join(dir, "ledger.sqlite"));
});
afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});
function seed(count: number) {
  ledger.tx(() => {
    const statement = ledger.db.prepare(
      "INSERT INTO actions(id,idempotency_key,payload,fingerprint,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    );
    for (let n = 0; n < count; n++) {
      const payment = PaymentInput.parse({
        idempotencyKey: "invoice." + String(n).padStart(6, "0"),
        recipient: n === 0 ? "Oldest review" : "Recipient " + n,
        amountCents: 1000,
        description: n === 0 ? "Unresolved oldest intent" : "Invoice " + n,
      });
      const date = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
      statement.run(
        randomUUID(),
        payment.idempotencyKey,
        JSON.stringify(payment),
        hash(payment),
        "PENDING_APPROVAL",
        date,
        date,
      );
    }
  });
}
describe("complete-ledger querying and export", () => {
  it("finds pending actions older than the 200-row snapshot and pages deterministically", () => {
    seed(205);
    expect(
      ledger
        .snapshot()
        .actions.some((row) => row.idempotency_key === "invoice.000000"),
    ).toBe(false);
    const oldest = ledger.listPage({
      status: "PENDING_APPROVAL",
      sort: "oldest",
      limit: 25,
    });
    expect(oldest).toMatchObject({
      total: 205,
      offset: 0,
      limit: 25,
      hasMore: true,
    });
    expect(oldest.items[0].idempotency_key).toBe("invoice.000000");
    const next = ledger.listPage({
      status: "PENDING_APPROVAL",
      sort: "oldest",
      limit: 25,
      offset: 25,
    });
    expect(
      new Set([...oldest.items, ...next.items].map((row) => row.id)).size,
    ).toBe(50);
    const search = ledger.listPage({ q: "oldest REVIEW" });
    expect(search.total).toBe(1);
    expect(search.items[0].idempotency_key).toBe("invoice.000000");
  });
  it("treats wildcard characters and SQL fragments as literal search text", () => {
    ledger.create({
      idempotencyKey: "literal-key-001",
      recipient: "100%_invoice",
      amountCents: 1000,
    });
    expect(ledger.listPage({ q: "%_" }).total).toBe(1);
    expect(ledger.listPage({ q: "'; DROP TABLE actions; --" }).total).toBe(0);
    expect(ledger.listPage({}).total).toBe(1);
  });
  it("combines search with status and preserves total beyond the last page", () => {
    seed(3);
    const id = ledger.listPage({ sort: "oldest" }).items[0].id;
    ledger.decide(id, "reject", "Reviewer", "Invalid invoice");
    expect(
      ledger.listPage({ q: "Oldest", status: "PENDING_APPROVAL" }).total,
    ).toBe(0);
    expect(ledger.listPage({ q: "Oldest", status: "REJECTED" }).total).toBe(1);
    expect(ledger.listPage({ offset: 500 })).toMatchObject({
      total: 3,
      items: [],
      hasMore: false,
    });
  });
  it("rejects oversized search and invalid query controls", () => {
    for (const query of [
      { q: "x".repeat(121) },
      { limit: 0 },
      { offset: -1 },
      { sort: "arbitrary SQL" },
      { status: "BYPASS" },
      { unknown: true },
    ])
      expect(() => ledger.listPage(query)).toThrow();
  });
  it("exports all filtered records beyond the snapshot in one consistent read", () => {
    seed(205);
    const csv = ledger.exportActions({ q: "invoice.", sort: "oldest" });
    expect(csv).toContain("invoice.000000");
    expect(csv).toContain("invoice.000204");
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(206);
    expect(
      ledger.exportActions({ q: "Oldest" }).split("\r\n").filter(Boolean),
    ).toHaveLength(2);
  });
  it("neutralizes spreadsheet formulas while preserving quotes and multiline text", () => {
    ledger.create({
      idempotencyKey: "formula-safe-01",
      recipient: ' =HYPERLINK("https://example.invalid")',
      amountCents: 1000,
    });
    ledger.create({
      idempotencyKey: "formula-safe-02",
      recipient: 'Alice\n"Quoted"',
      amountCents: 1000,
    });
    const csv = ledger.exportActions({});
    expect(csv).toContain('"\'=HYPERLINK(""https://example.invalid"")"');
    expect(csv).toContain('"Alice\n""Quoted"""');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });
  it("bounds memory-intensive exports instead of silently truncating evidence", () => {
    seed(MAX_EXPORT_ACTIONS + 1);
    expect(() => ledger.exportActions({})).toThrow("10,000");
    expect(ledger.listPage({ limit: 1 }).total).toBe(MAX_EXPORT_ACTIONS + 1);
  });
});
