"""Bind a read-only durable result tool to an application-owned intent."""

from __future__ import annotations

import json

from agents import FunctionTool, function_tool

from runtime_client import RuntimeClient


def make_result_tool(client: RuntimeClient) -> FunctionTool:
    """The agent cannot change the host-bound intent or approve or replay the action."""

    @function_tool(name_override="actionledger_wait", failure_error_function=None)
    async def wait_for_action() -> str:
        """Wait for the host-bound action to reach a verified successful result."""
        snapshot = await client.await_success()
        return json.dumps(
            {
                "intentId": snapshot.intent_id,
                "status": snapshot.status.value,
                "result": snapshot.result,
            }
        )

    return wait_for_action
