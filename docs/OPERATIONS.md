# Local operations

## Scoped agent mode

Run pnpm dev:headless, or pnpm start:headless after building. This starts the API and provider without the dashboard or browser credential bootstrap. The launcher creates a private data/agent-token.txt. Give only this token to the trusted agent host. Keep data/secrets.json and its operator/provider credentials outside the agent sandbox. The SDK wrapper accepts baseUrl, token, and a durable application-owned intentId.

The scoped token permits POST /api/actions, GET /api/actions/:id, and POST execution/recovery for approved intents. Approval, history lists, audit, export, and monitoring require the operator token. Human review uses authenticated operator REST requests; see [API reference](docs/API.md). There is no approval UI in headless mode. Never run default browser-bootstrap mode against the same stores while relying on scoped credential separation. Switching modes requires stopping and restarting.

This is API credential separation for trusted hosts. It does not isolate an agent that can read operator files, execute arbitrary host code, or access another operator service. Reviewer names remain attribution rather than separately authenticated human identities.

## Persistence and operations

Runtime files live in data/. Set DATA_DIR to an absolute path before launch to use a different directory. Both databases use WAL and synchronous=FULL with a five-second busy timeout.

- ledger.sqlite: actions, final decisions, attempts, application audit.
- provider.sqlite: simulated payments, retained provider keys, request counts.
- secrets.json: separate random bearer tokens. Never commit or share this file.

Keep each SQLite file and its WAL/SHM files together. For a simple consistent backup, stop the app cleanly and copy the whole data directory. Use a local filesystem, not a network share. A disk administrator can alter database and audit content. Server logs are structured and redact authorization headers. Node may emit a SQLite experimental warning on some supported versions.
