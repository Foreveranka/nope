import unittest

from sdk import BindingError
from sdk.receipt import _attempt_hash
from sdk.tests import test_receipt as legacy


class SelectedExecutorTests(unittest.TestCase):
    setUp = legacy.ReceiptTests.setUp
    build = legacy.ReceiptTests.build
    def selected(self):
        self.job["selected_executor"] = next(b["bidder"] for b in self.job["bids"] if b["commitment"])
        self.job["attempt_binding_version"] = 2
        self.job["attempt_binding_hash"] = list(_attempt_hash(self.job, 1))

    def test_selected_executor_claim(self):
        old = self.job["attempt_binding_hash"]
        self.selected()
        self.assertNotEqual(old, self.job["attempt_binding_hash"])
        self.assertEqual(self.build()["attempt_binding_hash"], self.job["attempt_binding_hash"])

    def test_selection_tamper_changes_attempt(self):
        self.selected()
        self.job["selected_executor"] = "unknown.near"
        with self.assertRaises(BindingError):
            self.build()

    def test_selection_cannot_downgrade_hash(self):
        self.selected()
        self.job["attempt_binding_version"] = 1
        with self.assertRaises(BindingError):
            self.build()

    def test_partial_selection_metadata_rejected(self):
        self.job["selected_executor"] = "unknown.near"
        with self.assertRaises(BindingError):
            self.build()


if __name__ == "__main__":
    unittest.main()
