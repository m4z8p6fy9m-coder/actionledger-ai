"""Real Agents SDK RunState, deterministic local Model, actual os._exit(86). No hosted model."""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import os
import socket
import sys
from pathlib import Path
from urllib.request import ProxyHandler, Request, build_opener

from agents import Agent, Model, Runner, RunState, function_tool, set_tracing_disabled
from agents.items import ModelResponse
from agents.usage import Usage
from openai.types.responses import (
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
)

from ledger_tool import LedgerPayment

set_tracing_disabled(True)


def offline_socket_guard(event, args):
    """Fail if this process or SDK attempts network access outside loopback."""
    if event == "socket.connect":
        connection, address = args
        if connection.family in {socket.AF_INET, socket.AF_INET6}:
            if address[0] not in {"127.0.0.1", "::1"}:
                raise RuntimeError("Offline regression rejected an external connection")
    if event == "socket.getaddrinfo" and args[0] not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("Offline regression rejected external DNS")


sys.addaudithook(offline_socket_guard)


class LocalPaymentModel(Model):
    async def get_response(
        self,
        system_instructions,
        input,
        model_settings,
        tools,
        output_schema,
        handoffs,
        tracing,
        **kwargs,
    ):
        history = input if isinstance(input, list) else []
        if any(item.get("type") == "function_call_output" for item in history):
            output = [
                ResponseOutputMessage(
                    id="fixture-final",
                    type="message",
                    role="assistant",
                    status="completed",
                    content=[
                        ResponseOutputText(
                            type="output_text",
                            annotations=[],
                            text="Fixture finished. Inspect the durable outcome.",
                        )
                    ],
                )
            ]
        else:
            output = [
                ResponseFunctionToolCall(
                    id="fixture-pay",
                    call_id="fixture-pay-call",
                    type="function_call",
                    name="pay",
                    arguments=json.dumps({"recipient": "Alice", "amount_cents": 1000}),
                )
            ]
        return ModelResponse(output=output, usage=Usage(), response_id=None)

    async def stream_response(self, *args, **kwargs):
        raise NotImplementedError("This fixture tests non-streamed RunState recovery")
        yield  # pragma: no cover


def save_state(path: Path, state: RunState):
    temporary = path.with_suffix(".next")
    with temporary.open("w", encoding="utf-8", newline="\n") as file:
        json.dump(state.to_json(), file)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)


async def main():
    phase, scenario, directory = sys.argv[1:4]
    folder = Path(directory)
    if phase not in {"prepare", "approve", "reject", "crash", "resume"}:
        raise ValueError("Unknown fixture phase")
    if scenario not in {
        "baseline",
        "ledger-checkpoint",
        "protected-gap",
        "unprotected-gap",
        "rejected",
    }:
        raise ValueError("Unknown fixture scenario")
    protected = scenario == "protected-gap"
    mode = "idempotent" if protected else "unprotected"
    token = os.environ["PYTHON_AGENT_TOKEN"]
    api_url = os.environ["PYTHON_API_URL"]
    client = LedgerPayment(api_url, token, "python." + scenario)

    @function_tool(needs_approval=True, failure_error_function=None)
    async def pay(recipient: str, amount_cents: int) -> str:
        """Pay the host-assigned fixture invoice after external human approval."""
        if scenario == "baseline":
            request = Request(
                os.environ["PYTHON_PROVIDER_URL"] + "/payments",
                data=json.dumps(
                    {
                        "idempotencyKey": "baseline.python.invoice",
                        "recipient": recipient,
                        "amountCents": amount_cents,
                        "currency": "EUR",
                        "providerMode": "unprotected",
                        "description": "Unsafe SDK baseline",
                    }
                ).encode(),
                headers={
                    "authorization": "Bearer " + os.environ["PYTHON_PROVIDER_TOKEN"],
                    "content-type": "application/json",
                },
                method="POST",
            )
            with build_opener(ProxyHandler({})).open(request, timeout=10) as response:
                outcome = {"status": "EXTERNAL_COMMIT", "receipt": json.load(response)}
        else:
            outcome = await asyncio.to_thread(
                client.pay,
                recipient,
                amount_cents,
                provider_mode=mode,
                simulate_engine_crash=phase == "crash" and scenario.endswith("-gap"),
            )
        if phase == "crash":
            # The provider has committed. The SDK cannot persist this tool result.
            os._exit(86)
        return json.dumps(outcome)

    agent = Agent(name="Offline payment regression", model=LocalPaymentModel(), tools=[pay])
    pending = folder / "pending.json"
    approved = folder / "approved.json"
    if phase == "prepare":
        result = await Runner.run(agent, "pay alice 10", context={})
        assert len(result.interruptions) == 1, "Expected a real SDK approval interruption"
        save_state(pending, result.to_state())
        report = {"phase": phase, "interruptions": len(result.interruptions)}
    elif phase in {"approve", "reject"}:
        state = await RunState.from_json(agent, json.loads(pending.read_text("utf-8")))
        interruptions = state.get_interruptions()
        assert len(interruptions) == 1
        if phase == "approve":
            state.approve(interruptions[0])
        else:
            state.reject(interruptions[0])
        save_state(approved, state)
        report = {"phase": phase, "storedDecision": phase}
    else:
        state = await RunState.from_json(agent, json.loads(approved.read_text("utf-8")))
        result = await Runner.run(agent, state)
        save_state(folder / "finished.json", result.to_state())
        outputs = [
            item.raw_item.get("output")
            for item in result.new_items
            if item.type == "tool_call_output_item" and isinstance(item.raw_item, dict)
        ]
        report = {
            "phase": phase,
            "interruptions": len(result.interruptions),
            "toolOutputs": outputs,
            "finalOutput": result.final_output,
        }
    report["sdkVersion"] = importlib.metadata.version("openai-agents")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
