"""Small offline HTTP adapter. Application-owned intent; no self-approval or blind retries."""

from __future__ import annotations

import json
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener


class LedgerPayment:
    def __init__(self, base_url: str, token: str, intent_id: str):
        url = urlsplit(base_url)
        if url.scheme != "http" or url.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("This local example requires a loopback HTTP API")
        if url.username or url.password or url.path not in {"", "/"} or url.query or url.fragment:
            raise ValueError("Use a bare loopback origin")
        if not token or not intent_id:
            raise ValueError("A host-owned token and durable intent ID are required")
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.intent_id = intent_id
        self.opener = build_opener(ProxyHandler({}))

    def request(self, route: str, body: dict | None = None) -> dict:
        request = Request(
            self.base_url + "/api" + route,
            data=None if body is None else json.dumps(body).encode(),
            headers={"authorization": "Bearer " + self.token, "content-type": "application/json"},
            method="GET" if body is None else "POST",
        )
        try:
            with self.opener.open(request, timeout=15) as response:
                result = json.load(response)
        except HTTPError as error:
            # Deliberately do not retry a possibly dispatched mutation.
            data = json.load(error)
            raise RuntimeError(data.get("message", "Ledger request failed")) from error
        if not isinstance(result, dict):
            raise ValueError("Expected an object from the local API")
        return result

    def pay(
        self,
        recipient: str,
        amount_cents: int,
        *,
        provider_mode: str = "idempotent",
        simulate_engine_crash: bool = False,
    ) -> dict:
        if isinstance(amount_cents, bool) or not isinstance(amount_cents, int) or amount_cents <= 0:
            raise ValueError("Use positive integer cents")
        if provider_mode not in {"idempotent", "unprotected"}:
            raise ValueError("Unsupported fixture provider policy")
        action = self.request(
            "/actions",
            {
                "idempotencyKey": "agent." + self.intent_id,
                "recipient": recipient,
                "amountCents": amount_cents,
                "currency": "EUR",
                "providerMode": provider_mode,
                "description": "Python SDK regression fixture",
            },
        )["action"]
        status = action["status"]
        if status == "SUCCEEDED":
            return {"status": status, "receipt": json.loads(action["receipt"])}
        if status in {"PENDING_APPROVAL", "REJECTED", "RUNNING"}:
            return {"status": status, "actionId": action["id"]}
        if status == "UNKNOWN" and provider_mode == "unprotected":
            return {"status": "UNKNOWN", "actionId": action["id"], "replayBlocked": True}
        if status not in {"READY", "UNKNOWN"}:
            raise ValueError("Unsupported ledger state")
        route = "recover" if status == "UNKNOWN" else "execute"
        body = {} if route == "recover" else {"simulateCrash": simulate_engine_crash}
        result = self.request("/actions/" + action["id"] + "/" + route, body)["action"]
        return {
            "status": result["status"],
            "actionId": result["id"],
            "receipt": json.loads(result["receipt"]) if result["receipt"] else None,
        }
