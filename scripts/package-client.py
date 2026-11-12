"""Publish only the reviewed companion code/public circuit; no runtime artifacts."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT=Path(__file__).resolve().parents[1]
WEB=['index.html','app.html','demo.html','styles.css','landing.js','app.js','input.mjs','demo.js','deployment.mjs']

def package(destination):
    files=[ROOT/'install-client.sh',ROOT/'scripts/client-launch.py']
    for directory in ['engine','engine/portable','service']:
        files+=sorted((ROOT/directory).glob('*.py'))
    for directory in ['engine/artifacts','engine/artifacts/portable-clean4-v1']:
        files += [ROOT/directory/name for name in ['server.zip','client-specs.json']]
    files += [ROOT/'web'/name for name in WEB]
    manifest={}; contents={}
    for file in files:
        if file.is_symlink() or not file.is_file() or file.stat().st_size>2097152:
            raise ValueError('Invalid client source: '+str(file))
        name=str(file.relative_to(ROOT));data=file.read_bytes()
        contents[name]=data;manifest[name]=hashlib.sha256(data).hexdigest()
    contents['FILES-SHA256.json']=(json.dumps(manifest,indent=2)+'\n').encode()
    contents['START-HERE.txt']=b'''NOPE customer companion (invitation-only encrypted-compute pilot)
1. Install Python 3.9-3.12 on macOS or Linux x86_64.
2. Open a terminal in this directory and run: sh install-client.sh
3. Run: .venv/bin/python scripts/client-launch.py
4. Enter the access invitation provided by your project operator.
5. In the local app, explicitly select remote encrypted evaluation.

The current fixed profile processes FOUR byte-valued id/value records.
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
            info.create_system=3;info.external_attr=(0o100755 if name=='install-client.sh' else 0o100644)<<16
            info.compress_type=zipfile.ZIP_DEFLATED;archive.writestr(info,data)
    print(json.dumps({'files':len(contents),'bytes':destination.stat().st_size,'sha256':hashlib.sha256(destination.read_bytes()).hexdigest()}))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('destination');package(parser.parse_args().destination)
