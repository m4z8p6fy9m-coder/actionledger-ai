# Security model

A trusted-machine, single-operator local reliability MVP. Do not expose it on an untrusted network without an appropriate identity, authorization, transport, and CSRF model.

## Controls

- Services bind to 127.0.0.1 and validate loopback Host values.
- The API rejects foreign Origin values; it emits no permissive CORS.
- Separate 256-bit random credentials protect ledger and provider. Same-origin browser bootstrap is no-store; normal browser isolation prevents foreign scripts reading it.
- secrets.json uses exclusive creation and mode 0600 where supported. Windows inherits parent directory ACLs; protect that directory.
- Strict Zod schemas reject unknown fields, validate bounded integer cents, and prohibit client risk downgrades.
- Transactions and owner-fenced checkpoints protect local races. Logical keys bind immutable approved payloads. State transitions and decisions are audited atomically.
- API body/rate limits bound requests. Production responses enforce same-origin CSP, frame denial, nosniff, and no-referrer.
- Generic error responses omit stack traces. Structured server logs redact authorization headers. Source packaging excludes runtime databases and credentials.

## Trust assumptions

Local processes and users with file/token access can call the API. One operator credential can approve and execute. Reviewer names provide attribution, not separately authenticated identity or separation of duties. A malicious agent given that full credential can approve its own intent. Optional headless mode disables browser credential bootstrap and accepts a distinct scoped agent token that cannot approve. Keep operator files and host access outside the agent sandbox. Production use still needs an appropriate authenticated human approval gateway.

Malicious same-origin scripts, browser extensions, administrators, or compromised dependencies can bypass local controls. SQLite and audits are unencrypted and not tamper-proof. Child workers inherit provider credentials. Do not provide real payment credentials to the simulator or include secrets in prompts. providerMode is a demonstration capability switch; real adapters must use server-controlled declarations grounded in verified provider contracts.

A local lease does not fence external execution. Provider idempotency must cover the entire retry horizon and the same account, key, and payload. Approvals, timeouts, negative read-backs, and local transactions cannot independently prove at-most-once external effects.

## Reporting

Do not post credentials or live payment/personal data in public issues. Report reproducible defects with synthetic payloads and redacted logs privately to the repository maintainer once a reporting channel is established. This source template does not invent a reporting address.

## Export and browser reliability (0.2)

CSV export is authenticated, uses bound search parameters, quotes multiline/quote-containing fields, and neutralizes formula-like cells before download. It has an explicit 10,000-action bound. Browser request timeouts do not imply dispatch failure: interrupted mutations are never automatically retried, and the operator is instructed to inspect the persisted outcome. Request IDs contain no credentials.

## Scoped headless access (0.3)

Run pnpm dev:headless or pnpm start:headless. Agent configuration fails closed unless session bootstrap is disabled and the token is distinct and at least 32 characters. The launcher creates a random agent-token.txt with exclusive creation and mode 0600 where supported. Agent tokens permit intent creation, known-action detail (including its audit/approval evidence), and execute/recover only; all other API routes require the operator credential. Session bootstrap returns 404 in headless mode even with an operator credential. There is no approval UI in this mode.

This does not prevent an unsandboxed local agent from reading files, starting another operator service, or executing arbitrary host code. Do not run dashboard mode against the same stores while relying on scoped credential separation. No per-agent action ownership or per-human identity is claimed.

## Reliability lab (0.4)

Lab routes require the operator token. Input is only a bounded integer seed; no user-supplied code, filesystem path, provider URL or executable is accepted. The lab creates synthetic approvals/payments exclusively in disposable stores. Its fault-capable provider is a separate child process, not an extension of the normal payment API. A partial unique index and a deadline bound concurrent lab work. This is process/storage separation, not an OS security sandbox. Reports contain synthetic payees and receipt IDs and no credentials. SHA-256 is an edit-detection fingerprint, not a signature or trusted attestation. Abrupt OS termination can leave synthetic temporary files.
