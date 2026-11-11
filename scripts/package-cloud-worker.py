"""Build an allowlisted deployment context; never copy local keys or runtime jobs."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]

def package(target):
    target = Path(target).resolve()
    allowed = (ROOT / 'runtime').resolve()
    if allowed not in target.parents or target == allowed:
        raise ValueError('Deployment staging must be a new directory under runtime/')
    target.mkdir(parents=True, exist_ok=False)
    files = [ROOT/'engine/__init__.py',ROOT/'engine/protocol.py',ROOT/'engine/worker.py']
    files += sorted((ROOT/'engine/portable').glob('*.py'))
    files += sorted((ROOT/'cloud/worker').glob('*.py'))
    files += [ROOT/'cloud/worker/requirements.txt']
    artifacts = ROOT/'engine/artifacts/portable-clean4-v1'
    files += [artifacts/name for name in ['server.zip','client-specs.json']]
    inventory = {}
    for source in files:
        if source.is_symlink() or not source.is_file(): raise ValueError('Missing regular build source: '+str(source))
        relative = source.relative_to(ROOT)
        destination = target/relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source,destination)
        inventory[str(relative)] = hashlib.sha256(source.read_bytes()).hexdigest()
    docker = ROOT/'cloud/worker/Dockerfile'
    shutil.copyfile(docker,target/'Dockerfile.vercel')
    inventory['Dockerfile.vercel'] = hashlib.sha256(docker.read_bytes()).hexdigest()
    # Do not include build inputs from the main static frontend project.
    (target/'vercel.json').write_text(json.dumps({'framework':'container'}))
    (target/'build-inventory.json').write_text(json.dumps(inventory,indent=2)+'\n')
    print(json.dumps({'context':str(target),'files':len(inventory),'containsCustomerInput':False,'containsKeys':False}))

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('target');package(parser.parse_args().target)
