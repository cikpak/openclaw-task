import json, pathlib, sys, time
from snapshot_common import inventory, inventory_digest
from snapshot_sqlite import database_checks
from snapshot_capture import capture
from snapshot_restore import restore
if __name__ == '__main__':
    started = time.monotonic(); action, directory = sys.argv[1:3]; stage = pathlib.Path(directory)
    if action == 'capture':
        data = sys.stdin.read(); result = capture(stage, sys.argv[3], json.loads(data).get('previousFiles', []) if data else [])
    elif action == 'restore': result = restore(stage, json.loads(sys.stdin.read()))
    elif action == 'inspect':
        entries = inventory(); result = dict(inventoryDigest=inventory_digest(entries), entries=len(entries), databases=database_checks(entries))
    else: raise ValueError('Unknown checkpoint action')
    result['wallMs'] = round((time.monotonic() - started) * 1000)
    print(json.dumps(result))
