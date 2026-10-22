"""Validate SQLite with the pinned image's Node runtime, against expendable clones."""
import os, pathlib, shutil, subprocess, tempfile
from snapshot_common import ROOT, excluded

def database_checks(entries, root=ROOT):
    checks = []
    for entry in entries:
        if entry['kind'] != 'file': continue
        path = root / entry['path']
        with open(path, 'rb') as source:
            if source.read(16) != b'SQLite format 3\x00': continue
        with tempfile.TemporaryDirectory(prefix='sqlite-', dir=os.environ.get('HELPER_RUNTIME', '/var/lib/messenger-helper')) as temporary:
            clone = pathlib.Path(temporary) / path.name; shutil.copyfile(path, clone)
            for suffix in ('-wal', '-shm', '-journal'):
                sidecar = pathlib.Path(str(path) + suffix)
                if sidecar.exists():
                    if sidecar.is_symlink() or not sidecar.is_file(): raise ValueError('Unsafe SQLite sidecar')
                    shutil.copyfile(sidecar, pathlib.Path(str(clone) + suffix))
            checked = subprocess.run(['node', str(pathlib.Path(__file__).with_name('sqlite-check.mjs')), str(clone)], capture_output=True, timeout=120)
            if checked.returncode != 0: raise ValueError('SQLite integrity failed')
        checks.append(entry['path'])
    return checks
