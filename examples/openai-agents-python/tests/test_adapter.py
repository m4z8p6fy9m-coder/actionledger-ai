import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ledger_tool import LedgerPayment  # noqa: E402


class PaymentAdapterTests(unittest.TestCase):
    def client(self, status):
        client = LedgerPayment("http://127.0.0.1:4310", "fixture-token", "durable-invoice")
        client.request = Mock(
            return_value={"action": {"id": "a", "status": status, "receipt": None}}
        )
        return client

    def test_restricts_origin(self):
        for origin in ["https://example.com", "http://127.0.0.1/private", "http://x@localhost"]:
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                LedgerPayment(origin, "token", "intent")

    def test_requires_positive_integer_cents(self):
        client = self.client("READY")
        for amount in [True, 0, -1, 10.5, "1000"]:
            with self.subTest(amount=amount), self.assertRaises(ValueError):
                client.pay("Alice", amount)
        client.request.assert_not_called()

    def test_unprotected_uncertainty_never_dispatches(self):
        client = self.client("UNKNOWN")
        result = client.pay("Alice", 1000, provider_mode="unprotected")
        self.assertTrue(result["replayBlocked"])
        self.assertEqual(client.request.call_count, 1)

    def test_final_veto_and_pending_approval_never_dispatch(self):
        for status in ["PENDING_APPROVAL", "REJECTED", "RUNNING"]:
            client = self.client(status)
            self.assertEqual(client.pay("Alice", 1000)["status"], status)
            self.assertEqual(client.request.call_count, 1)

    def test_cached_receipt_never_dispatches(self):
        client = self.client("SUCCEEDED")
        client.request.return_value["action"]["receipt"] = '{"paymentId":"fixture"}'
        self.assertEqual(client.pay("Alice", 1000)["receipt"]["paymentId"], "fixture")
        self.assertEqual(client.request.call_count, 1)

    def test_transport_error_is_not_retried(self):
        client = self.client("READY")
        client.request.side_effect = RuntimeError("response lost")
        with self.assertRaises(RuntimeError):
            client.pay("Alice", 1000)
        self.assertEqual(client.request.call_count, 1)

    def test_protected_recovery_uses_same_durable_intent(self):
        client = self.client("UNKNOWN")
        client.request.side_effect = [
            {"action": {"id": "a", "status": "UNKNOWN"}},
            {"action": {"id": "a", "status": "SUCCEEDED", "receipt": '{"paymentId":"one"}'}},
        ]
        result = client.pay("Alice", 1000)
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertEqual(
            client.request.call_args_list[0].args[1]["idempotencyKey"], "agent.durable-invoice"
        )
        self.assertEqual(client.request.call_args_list[1].args, ("/actions/a/recover", {}))


if __name__ == "__main__":
    unittest.main()
