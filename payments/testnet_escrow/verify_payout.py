"""Read-only real public-testnet receipt verification; no wallet/key access."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent.parent))
from payments.http import strict_json
from payments.near_testnet import NearTestnetRPC, TestnetPaymentBinding
from payments.near_testnet_escrow import EscrowConfig, NearTestnetEscrowClient


def main():
    value = strict_json((ROOT / 'verification/testnet-payout.json').read_bytes())
    config = EscrowConfig(value['escrow_id'], value['escrow_code_hash'], value['registry_id'], value['registry_code_hash'])
    fields = ('registry_id', 'registry_code_hash', 'job_id', 'buyer_id', 'provider_id',
        'context_hash', 'job_binding_hash', 'attempt', 'attempt_binding_hash', 'receipt_hash', 'output_hash')
    binding = TestnetPaymentBinding(amount_yocto=int(value['amount_yocto']), **{k: value[k] for k in fields})
    result = NearTestnetEscrowClient(config, NearTestnetRPC()).verify_release(value['release_hash'], binding)
    (ROOT / 'verification/testnet-payout-verified.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'network': 'testnet', 'error': 'FINAL_ESCROW_PAYOUT_UNVERIFIED_NO_RESEND'}), file=sys.stderr)
        sys.exit(1)
