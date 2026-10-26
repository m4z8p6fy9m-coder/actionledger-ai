import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const production = process.argv.includes("--production");
const headless = process.argv.includes("--headless");
const data = resolve(process.env.DATA_DIR ?? "data");
await mkdir(data, { recursive: true });
const secretsFile = resolve(data, "secrets.json");
let secrets;
try {
  secrets = JSON.parse(await readFile(secretsFile, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  secrets = {
    apiToken: randomBytes(32).toString("hex"),
    providerToken: randomBytes(32).toString("hex"),
  };
  try {
    await writeFile(secretsFile, JSON.stringify(secrets, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    secrets = JSON.parse(await readFile(secretsFile, "utf8"));
  }
}
if (
  typeof secrets.apiToken !== "string" ||
  secrets.apiToken.length < 32 ||
  typeof secrets.providerToken !== "string" ||
  secrets.providerToken.length < 32
)
  throw new Error("Invalid data/secrets.json");
const require = createRequire(import.meta.url);
if (!production) {
  const tsc = require.resolve("typescript/bin/tsc");
  const check = spawnSync(process.execPath, [tsc, "-p", "packages/core"], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (check.status !== 0) process.exit(check.status ?? 1);
}
let agentToken;
if (headless) {
  const agentFile = resolve(data, "agent-token.txt");
  try {
    await writeFile(agentFile, randomBytes(32).toString("hex"), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  agentToken = (await readFile(agentFile, "utf8")).trim();
  if (agentToken.length < 32 || agentToken === secrets.apiToken)
    throw new Error("Invalid scoped agent token");
}
const env = {
  ...process.env,
  DATA_DIR: data,
  API_TOKEN: secrets.apiToken,
  AGENT_TOKEN: agentToken,
  HEADLESS: String(headless),
  PROVIDER_TOKEN: secrets.providerToken,
  NODE_ENV: production ? "production" : "development",
};
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 500).unref();
}
function start(args) {
  const child = spawn(process.execPath, args, {
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  children.push(child);
  child.on("error", (e) => {
    console.error(e.message);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
  return child;
}
async function ready(url, token) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url, {
        headers: token ? { authorization: "Bearer " + token } : {},
        signal: AbortSignal.timeout(500),
      });
      if (r.ok) return;
    } catch {
      /* service may still be starting */
    }
    if (stopping) throw new Error("Startup failed");
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out waiting for " + url);
}
try {
  start(
    production
      ? ["apps/provider/dist/index.js"]
      : ["--import", "tsx", "apps/provider/src/index.ts"],
  );
  await ready("http://127.0.0.1:4311/health", secrets.providerToken);
  start(
    production
      ? ["apps/server/dist/index.js"]
      : ["--import", "tsx", "apps/server/src/index.ts"],
  );
  await ready("http://127.0.0.1:4310/api/health");
  if (!production && !headless) {
    const webRequire = createRequire(resolve(root, "apps/web/package.json"));
    const vite = resolve(
      dirname(webRequire.resolve("vite/package.json")),
      "bin/vite.js",
    );
    start([vite, "apps/web", "--host", "127.0.0.1"]);
  }
  console.log(
    "\nActionLedger AI → " +
      (headless
        ? "headless API http://127.0.0.1:4310 (browser bootstrap disabled)"
        : production
          ? "http://127.0.0.1:4310"
          : "http://127.0.0.1:5173") +
      "\nPersistent local data: " +
      data +
      "\nCtrl+C to stop.\n",
  );
} catch (e) {
  console.error(e.message);
  stop(1);
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
