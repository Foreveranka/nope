"""Publish only the reviewed companion code/public circuit; no runtime artifacts."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT=Path(__file__).resolve().parents[1]
WEB=['gc-verify-worker.mjs','csv-local.html','csv-browser.js','csv-gc-worker.mjs','gc-core.mjs','gc-client.mjs','verify.html','verify.js','try.css','csv.html','csv.js','csv.css','csv-input.mjs','privacy.html','privacy.js','privacy.css','market.html','market.js','market.css','sealed.mjs','index.html','app.html','demo.html','styles.css','landing.js','app.js','input.mjs','demo.js','deployment.mjs']

def package(destination):
    files=[ROOT/'Start-NOPE.command',ROOT/'install-client.sh',ROOT/'scripts/client-launch.py']
    for directory in ['engine','engine/portable','service','sdk']:
        files+=sorted((ROOT/directory).glob('*.py'))
    for directory in ['engine/artifacts','engine/artifacts/portable-clean4-v1']:
        files += [ROOT/directory/name for name in ['server.zip','client-specs.json']]
    files += [ROOT/'web'/name for name in WEB]
    files += [ROOT/'service'/name for name in ['procurement-config.json','procurement-policy.json']]
    files += [ROOT/'mpc'/name for name in ['v2.py','auction.py','sealed_client.py','network_profile.py','programs/sealed_procurement_v2.mpc','programs/sealed_procurement.mpc']]
    manifest={}; contents={}
    for file in files:
        if file.is_symlink() or not file.is_file() or file.stat().st_size>2097152:
            raise ValueError('Invalid client source: '+str(file))
        name=str(file.relative_to(ROOT));data=file.read_bytes()
        contents[name]=data;manifest[name]=hashlib.sha256(data).hexdigest()
    contents['FILES-SHA256.json']=(json.dumps(manifest,indent=2)+'\n').encode()
    contents['START-HERE.txt']=b'''NOPE customer-owned CSV encrypted-compute client
1. Install Python 3.9-3.12 on macOS or Linux x86_64.
2. Open a terminal in this directory and run: sh install-client.sh
3. Run: .venv/bin/python scripts/client-launch.py
4. Select a CSV and its numeric column on the local /csv page. No invitation for local evaluation.
5. Download the verified output CSV. Optional cloud: add --cloud and enter your compute invitation.

For the procurement workspace instead:
  .venv/bin/python scripts/client-launch.py --market
Enter the buyer/provider role invitation on the opened local /market page.
The compute invitation and procurement role invitation are separate credentials.
Owner-only testnet publication additionally requires the configured owner
repository and its local test wallet; it is disabled in this standalone package.

CSV mode processes 1-32 rows in encrypted four-record batches; only the selected column goes to the loopback client. Other CSV columns remain in your browser. CSV mode replaces empty with zero and caps values above 100; it does NOT flag duplicates.
The separate record-level profile processes FOUR byte-valued id/value records.
It flags later duplicate IDs, converts sentinel 255 to zero, and caps other
values at 100. This is not a generic CSV processing service.
Input and decryption keys stay in the local Python companion. The remote
worker receives ciphertext and public evaluation keys. No live payments or
independent MPC auction are included in this companion release. A closed
companion/crashed computer loses the in-memory decryption key; do not close
the terminal before retrieving the result. The app does not persist plaintext.
'''
    destination=Path(destination);destination.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(destination,'w',compression=zipfile.ZIP_DEFLATED) as archive:
        for name,data in sorted(contents.items()):
            info=zipfile.ZipInfo('nope-client/'+name,(1980,1,1,0,0,0))
            info.create_system=3;info.external_attr=(0o100755 if name in ('install-client.sh','Start-NOPE.command') else 0o100644)<<16
            info.compress_type=zipfile.ZIP_DEFLATED;archive.writestr(info,data)
    print(json.dumps({'files':len(contents),'bytes':destination.stat().st_size,'sha256':hashlib.sha256(destination.read_bytes()).hexdigest()}))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('destination');package(parser.parse_args().destination)
