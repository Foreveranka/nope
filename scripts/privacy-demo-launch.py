#!/usr/bin/env python3
"""Launch the owner-local real crypto + NEAR testnet demo, never a public signer."""
import argparse
import os
from pathlib import Path
import sys
import webbrowser

ROOT=Path(__file__).resolve().parents[1]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8766)
    parser.add_argument('--no-browser',action='store_true')
    args=parser.parse_args()
    # Full reviewed operator checkout required; customer ZIP cannot turn into a signer.
    for name in ['integration/privacy_demo.py','mpc/vendor/MP-SPDZ/spdz2k-party.x',
                 'contracts/registry/deploy/runtime/near-testnet/identity.json',
                 'payments/testnet_escrow/client.mjs']:
        path=ROOT/name
        if not path.is_file() or path.is_symlink():
            parser.error('Configured owner checkout and native/testnet dependencies required: '+name)
    if os.environ.get('VEIL_CUSTOMER_TOKEN'):
        parser.error('Run in an operator shell without a remote-compute customer invitation.')
    os.environ['NOPE_ENABLE_PRIVACY_DEMO']='1'
    sys.path.insert(0,str(ROOT))
    from service.server import create_server
    server=create_server(port=args.port,runtime_dir=ROOT/'runtime')
    print('NOPE Privacy demo: '+server.origin+'/privacy',flush=True)
    print('Clicking Start runs fixed synthetic inputs, real FHE/MPC and testnet-only settlement. No mainnet.',flush=True)
    if not args.no_browser: webbrowser.open(server.origin+'/privacy')
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()

if __name__=='__main__': main()
