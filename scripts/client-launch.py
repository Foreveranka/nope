"""Start the customer-owned companion; invitation and decryption keys stay local."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import sys
import webbrowser

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--invitation-file',type=Path)
    parser.add_argument('--port',type=int,default=8765)
    parser.add_argument('--no-browser',action='store_true')
    args=parser.parse_args()
    if args.invitation_file:
        p=args.invitation_file
        if p.is_symlink() or not p.is_file() or p.stat().st_size>8192:
            parser.error('Invalid invitation file.')
        token=json.loads(p.read_text())['token']
    else:
        token=getpass.getpass('NOPE access invitation (hidden): ').strip()
    if not isinstance(token,str) or not re.fullmatch(r'[A-Za-z0-9_-]{43,128}',token):
        parser.error('Invalid invitation format.')
    os.environ['VEIL_CLOUD_URL']='https://veil-procurement.vercel.app'
    os.environ['VEIL_CUSTOMER_TOKEN']=token
    sys.path.insert(0,str(ROOT))
    from service.server import create_server
    server=create_server(port=args.port,runtime_dir=ROOT/'runtime')
    print('NOPE companion: '+server.origin+'/app',flush=True)
    print('Your input and decryption key remain on this computer. Keep this window open.',flush=True)
    if not args.no_browser: webbrowser.open(server.origin+'/app')
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()

if __name__=='__main__': main()
