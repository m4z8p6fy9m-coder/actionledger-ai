# Local REST API

Base URL: http://127.0.0.1:4310/api. JSON only. API requests are limited to 8 KiB and 300/minute per client IP. Host must be loopback; supplied Origin must be an allowed local dashboard/API origin. No permissive CORS is emitted.

Trusted local CLI/adapters read apiToken from data/secrets.json and send Authorization: Bearer <token>. Never include tokens in prompts. The browser bootstraps its session over the same origin through Vite or the built static server.

| Method | Route                                              | Behavior                                                  |
| ------ | -------------------------------------------------- | --------------------------------------------------------- |
| GET    | /health                                            | Public local service health/version                       |
| GET    | /session                                           | Public same-origin local token bootstrap, no-store        |
| GET    | /state                                             | Recent 200 records, global counts, provider state, policy |
| GET    | /actions?limit=50&offset=0&status=UNKNOWN          | Paginated actions, optional exact status; limit 1–200     |
| GET    | /action-page?q=Alice&sort=oldest&limit=25&offset=0 | Full-history search with result metadata                  |
| GET    | /actions/export?q=Alice&status=UNKNOWN             | Consistent authenticated filtered CSV                     |
| POST   | /actions                                           | Persist intent or return exact duplicate                  |
| GET    | /actions/:id                                       | Action, decision, ordered attempts, full per-action audit |
| POST   | /actions/:id/approval                              | Persist final approve/reject decision                     |
| POST   | /actions/:id/execute                               | Execute approved action, optional simulated crash         |
| POST   | /actions/:id/recover                               | Expire abandoned lease; recover protected uncertainty     |
| GET    | /audit?after=0&limit=100                           | Ascending sequence cursor; limit 1–500                    |

Create body:

```json
{
  "idempotencyKey": "invoice.2026.001",
  "recipient": "Alice",
  "amountCents": 1000,
  "currency": "EUR",
  "providerMode": "idempotent",
  "description": "Invoice payment"
}
```

Unknown fields are rejected. Keys are 8–128 ASCII alphanumeric characters or underscore/dot/colon/hyphen. Amounts are integer cents, 1–100,000,000. Recipients are 1–100 trimmed characters; descriptions at most 240. Defaults: EUR, idempotent, Agent payment. Client risk overrides are forbidden. The amount ceiling is a validation bound, not a real-payment spending policy.

Create returns 201 {action,duplicate:false}; exact duplicate returns 200 {action,duplicate:true}; changed payload returns 409 KEY_CONFLICT.

Approval body:

```json
{
  "decision": "approve",
  "actor": "Local reviewer",
  "reason": "Verified amount and recipient"
}
```

Actor/reason are required, trimmed, and bounded to 80/300 characters. decision reject permanently blocks execution. Repeated identical decisions return current state; an opposite decision returns 409 DECISION_FINAL.

Execute accepts {} or {"simulateCrash":true}. Recovery accepts {}. Execution returns {action,crashed,cached}. An expected crash returns crashed:true and UNKNOWN: a successful simulation response is not evidence of payment failure. SUCCEEDED returns cached:true without dispatch. Other codes:

- 400 VALIDATION_ERROR: invalid strict body, query, or UUID.
- 401 UNAUTHORIZED: missing/invalid bearer token.
- 403 HOST_DENIED / ORIGIN_DENIED: invalid browser context.
- 404 NOT_FOUND: unknown action.
- 409 APPROVAL_REQUIRED / IN_PROGRESS: not authorized or live execution lease.
- 409 UNSAFE_RETRY: uncertain unprotected action, or ordinary execute on UNKNOWN.
- 409 ATTEMPTS_EXHAUSTED: five attempts already recorded.
- 429: request rate limit.
- 503 EXECUTION_INCOMPLETE: child could not checkpoint; inspect durable state.
- 500 INTERNAL_ERROR: unexpected error, generic response with redacted server log.

The state endpoint remains available when the provider is down, returning provider:null and providerError.

## Separate provider

http://127.0.0.1:4311 requires its own providerToken for every route, including /health. POST /payments accepts the normalized payment shape. GET /payments returns recent receipts plus all-time paymentCount, totalCents, requestCount, and deduplicated. The engine never interprets this diagnostic read as permission to replay an unprotected action.

No route deletes evidence, forces retry, or overrides UNKNOWN to success. See README.md for the guarantee boundary.

## Search, export, and request diagnostics (0.2)

Both action listing routes support optional q (trimmed literal text, maximum 120 characters), status, and sort (newest or oldest). Search covers the entire stored action ID, logical key, recipient, and description; matching is case-insensitive for ASCII text. SQL wildcards such as % and _ are ordinary characters. Parameters are bound; user text is never interpolated into SQL. Ordering uses creation time plus ID for a deterministic tie-breaker.

GET /action-page returns {items,total,limit,offset,hasMore}; its default page size is 25. GET /actions retains its original array response and default page size of 50 for compatibility. Queries reject unknown fields, invalid states, negative offsets, and page sizes above 200.

GET /actions/export accepts only q, status, and sort; it exports every matching record, independently of the visible page. Rows and count are read under the same SQLite transaction. More than 10,000 matches returns 422 EXPORT_TOO_LARGE instead of silent truncation. Successful responses use text/csv, UTF-8 BOM, quoted fields, CRLF row separators, and Content-Disposition: attachment. Formula-like spreadsheet cells are prefixed with an apostrophe. Export requires the same bearer authentication as ledger access.

Responses include X-Request-Id, including authentication and validation failures. The browser preserves that reference on structured errors; unexpected API errors are logged through the request logger. There is no request payload or secret in the generated ID. Local authentication and all approval/recovery restrictions are unchanged.

## Scoped credentials (0.3)

In headless mode, session bootstrap always returns 404 SESSION_DISABLED. A distinct agent token may POST /api/actions, GET /api/actions/:id, or POST /api/actions/:id/execute and /recover. Operator credentials may use every authenticated route. Other agent-token requests return 403 SCOPE_DENIED; missing or invalid credentials return 401 UNAUTHORIZED. Approval still requires the operator credential and a nonempty reviewer/reason. There is no browser credential exchange in this mode.

A human reviews the payload with GET /api/actions/:id using the operator bearer token, then POSTs /api/actions/:id/approval with {"decision":"approve","actor":"Reviewer","reason":"Checked exact payee and amount"}. Use your HTTP client to load the token from the protected secrets file; do not commit tokens or put them in URLs. The agent resumes the existing intent after this explicit decision.
