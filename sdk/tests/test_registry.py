import copy
import json
import unittest
from pathlib import Path

from sdk.registry import verify_registry_job
from sdk import BindingError


class RegistryViewTests(unittest.TestCase):
    def setUp(self):
        p = Path(__file__).resolve().parents[2] / "contracts/registry/examples/lifecycle.json"
        self.fixture = json.loads(p.read_text())
        self.job = copy.deepcopy(self.fixture["job"])
        self.job["state"] = "Executing"

    def verify(self, **kw):
        return verify_registry_job(self.job, contract_account=kw.get("contract", self.fixture["contract_account"]),
                                   network_domain_hash=self.fixture["network_domain_hash"],
                                   expected_config=kw.get("config"))

    def test_saved_hash_vector(self):
        self.assertTrue(self.verify())

    def test_cross_contract_rejected(self):
        with self.assertRaises(BindingError):
            self.verify(contract="other.near")

    def test_config_tamper_rejected(self):
        self.job["config"]["context_hash"][0] ^= 1
        with self.assertRaises(BindingError):
            self.verify()

    def test_omitted_bid_rejected(self):
        self.job["bids"].pop()
        with self.assertRaises(BindingError):
            self.verify()

    def test_other_intent_rejected(self):
        config = copy.deepcopy(self.job["config"])
        config["executor"] = "other.near"
        with self.assertRaises(BindingError):
            self.verify(config=config)
