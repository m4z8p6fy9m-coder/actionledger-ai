import asyncio
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agents.tool_context import ToolContext  # noqa: E402

from runtime_client import RuntimeClient, Status  # noqa: E402
from runtime_tool import make_result_tool  # noqa: E402


class RuntimeClientTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.statuses = ["UNKNOWN", "SUCCEEDED"]
        self.methods = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                outer.methods.append("GET")
                status = outer.statuses.pop(0) if len(outer.statuses) > 1 else outer.statuses[0]
                body = json.dumps(
                    {"id": "invoice-1", "status": status, "result": {"paymentIntentId": "pi_one"}}
                ).encode()
                self.send_response(200)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.checkpoint = Path(self.directory.name) / "agent-result.json"
        self.client = RuntimeClient(
            "http://127.0.0.1:" + str(self.server.server_port),
            "a" * 40,
            "invoice-1",
            self.checkpoint,
        )

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def test_repaired_outcome_is_checkpointed_without_dispatch(self):
        result = asyncio.run(self.client.await_success(timeout=2, interval=0.01))
        self.assertEqual(result.status, Status.SUCCEEDED)
        self.assertEqual(self.methods, ["GET", "GET"])
        saved = self.checkpoint.read_text()
        self.assertNotIn("a" * 40, saved)
        self.assertEqual(json.loads(saved)["result"]["paymentIntentId"], "pi_one")
        asyncio.run(self.client.await_success(timeout=2, interval=0.01))
        self.assertEqual(self.checkpoint.read_text(), saved)

    def test_real_sdk_tool_returns_only_host_bound_checkpointed_success(self):
        tool = make_result_tool(self.client)
        context = ToolContext(
            context={}, tool_name="actionledger_wait", tool_call_id="call-one", tool_arguments="{}"
        )
        output = asyncio.run(tool.on_invoke_tool(context, "{}"))
        self.assertEqual(json.loads(output)["intentId"], "invoice-1")
        self.assertEqual(self.methods, ["GET", "GET"])
        self.assertTrue(self.checkpoint.exists())

    def test_unresolved_unknown_never_becomes_success(self):
        self.statuses = ["UNKNOWN"]
        with self.assertRaises(TimeoutError):
            asyncio.run(self.client.await_success(timeout=0.08, interval=0.01))
        self.assertFalse(self.checkpoint.exists())
        self.assertEqual(set(self.methods), {"GET"})

    def test_rejection_does_not_write_a_success_checkpoint(self):
        self.statuses = ["REJECTED"]
        with self.assertRaises(RuntimeError):
            asyncio.run(self.client.await_success(timeout=2))
        self.assertFalse(self.checkpoint.exists())

    def test_rejects_conflicting_existing_checkpoint(self):
        self.statuses = ["SUCCEEDED"]
        self.checkpoint.write_text('{"intentId":"different-intent"}')
        with self.assertRaises(ValueError):
            asyncio.run(self.client.await_success(timeout=2))
        self.assertEqual(json.loads(self.checkpoint.read_text())["intentId"], "different-intent")

    def test_rejects_unsafe_origins_and_untrusted_intent_paths(self):
        for origin in [
            "http://example.com",
            "https://user:pass@example.com",
            "http://localhost/path",
        ]:
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                RuntimeClient(origin, "a" * 40, "invoice-1", self.checkpoint)
        with self.assertRaises(ValueError):
            RuntimeClient("http://localhost", "a" * 40, "../another", self.checkpoint)


if __name__ == "__main__":
    unittest.main()
