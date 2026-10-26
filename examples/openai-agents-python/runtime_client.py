"""Read-only bridge from durable runtime outcomes to an application checkpoint."""

from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from urllib.parse import quote, urlsplit
from urllib.request import ProxyHandler, Request, build_opener


class Status(str, Enum):
    PENDING_APPROVAL = "PENDING_APPROVAL"
    READY = "READY"
    RUNNING = "RUNNING"
    UNKNOWN = "UNKNOWN"
    SUCCEEDED = "SUCCEEDED"
    REJECTED = "REJECTED"


@dataclass(frozen=True)
class Snapshot:
    intent_id: str
    status: Status
    result: object


class RuntimeClient:
    """The trusted host supplies credentials and intent. This client cannot dispatch or approve."""

    def __init__(self, origin: str, token: str, intent_id: str, checkpoint: Path) -> None:
        url = urlsplit(origin)
        if url.username or url.password or url.path not in {"", "/"} or url.query or url.fragment:
            raise ValueError("Use a bare API origin")
        if url.scheme != "https" and not (
            url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"}
        ):
            raise ValueError("Use HTTPS or loopback HTTP")
        if not url.hostname or len(token) < 32:
            raise ValueError("A host and scoped agent credential are required")
        if not re.fullmatch(r"[a-zA-Z0-9_.:-]{1,128}", intent_id):
            raise ValueError("Invalid host intent ID")
        self.origin = origin.rstrip("/")
        self.token = token
        self.intent_id = intent_id
        self.checkpoint = checkpoint
        self.opener = build_opener(ProxyHandler({}))

    def read(self) -> Snapshot:
        request = Request(
            self.origin + "/v1/intents/" + quote(self.intent_id, safe=""),
            headers={"authorization": "Bearer " + self.token},
            method="GET",
        )
        with self.opener.open(request, timeout=5) as response:
            raw = response.read(262145)
        if len(raw) > 262144:
            raise ValueError("Runtime response too large")
        data: object = json.loads(raw)
        if not isinstance(data, dict) or data.get("id") != self.intent_id:
            raise ValueError("Runtime returned a different intent")
        status: object = data.get("status")
        if not isinstance(status, str):
            raise ValueError("Invalid runtime status")
        return Snapshot(self.intent_id, Status(status), data.get("result"))

    def _save(self, snapshot: Snapshot) -> None:
        if snapshot.status is not Status.SUCCEEDED:
            raise ValueError("Only verified success can become a result checkpoint")
        payload = {
            "intentId": snapshot.intent_id,
            "status": snapshot.status.value,
            "result": snapshot.result,
        }
        if self.checkpoint.exists():
            previous: object = json.loads(self.checkpoint.read_text("utf-8"))
            if previous != payload:
                raise ValueError("Refusing to overwrite a different result checkpoint")
            return
        self.checkpoint.parent.mkdir(parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(prefix=".actionledger-", dir=self.checkpoint.parent)
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as file:
                json.dump(payload, file)
                file.flush()
                os.fsync(file.fileno())
            try:
                os.link(temporary, self.checkpoint)
            except FileExistsError:
                concurrent: object = json.loads(self.checkpoint.read_text("utf-8"))
                if concurrent != payload:
                    raise ValueError(
                        "Refusing to overwrite a different result checkpoint"
                    ) from None
        finally:
            temporary.unlink(missing_ok=True)

    async def await_success(self, timeout: float = 30, interval: float = 0.5) -> Snapshot:
        if timeout <= 0 or interval <= 0:
            raise ValueError("Use positive polling limits")
        async with asyncio.timeout(timeout):
            while True:
                snapshot = await asyncio.to_thread(self.read)
                if snapshot.status is Status.SUCCEEDED:
                    await asyncio.to_thread(self._save, snapshot)
                    return snapshot
                if snapshot.status is Status.REJECTED:
                    raise RuntimeError("The durable action was rejected")
                # UNKNOWN remains unknown: polling never issues a POST.
                await asyncio.sleep(interval)
