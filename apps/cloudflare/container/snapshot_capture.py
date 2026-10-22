import base64, json, pathlib, shutil, tarfile
from snapshot_common import ROOT, inventory, inventory_digest, digest, user_roots, is_user, root_metadata
from snapshot_sqlite import database_checks

def capture(stage, checkpoint):
    if not checkpoint or len(checkpoint) > 80 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in checkpoint): raise ValueError('Invalid checkpoint')
    before = inventory()
    total = sum(entry.get('size', 0) for entry in before)
    required = total + total // 1000 + len(before) * 4096 + 32 * 1024 * 1024
    if shutil.disk_usage(stage.parent).free < required: raise ValueError('Insufficient capture staging capacity')
    databases = database_checks(before)
    config = json.loads((ROOT / 'state/openclaw.json').read_text()); roots = user_roots(config)
    stage.mkdir(mode=0o700, exist_ok=False); prefix = 'recovery/' + checkpoint
    objects = []
    for entry in before:
        if entry['kind'] == 'file' and is_user(entry['path'], roots):
            name = 'user-' + entry['sha256']
            if not (stage / name).exists(): shutil.copyfile(ROOT / entry['path'], stage / name)
            objects.append(dict(key='files/' + entry['sha256'], local=name, **{key:entry[key] for key in ('path', 'size', 'sha256', 'mode', 'uid', 'gid')}))
    separated = {entry['path'] for entry in objects}
    with tarfile.open(stage / 'internal.tar.gz', 'w:gz', dereference=False) as archive:
        for entry in before:
            if entry['path'] in separated: continue
            path = ROOT / entry['path']; member = archive.gettarinfo(str(path), arcname=entry['path'])
            if entry['kind'] == 'file':
                member.type = tarfile.REGTYPE; member.linkname = ''; member.size = entry['size']
                with open(path, 'rb') as source: archive.addfile(member, source)
            else: archive.addfile(member)
    if inventory() != before: raise ValueError('Recovery source changed during capture')
    manifest = dict(version=1, checkpointId=checkpoint, inventory=before, inventoryDigest=inventory_digest(before), root=root_metadata(), userRoots=roots, excluded=['cache', 'tmp'], files=objects, databases=databases, compatibility=dict(openclaw='2026.10.1', format='messenger-1'))
    (stage / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True, separators=(',', ':')))
    def descriptor(name, key):
        path = stage / name
        return dict(key=key, size=path.stat().st_size, sha256=digest(path), md5=base64.b64encode(bytes.fromhex(digest(path, 'md5'))).decode())
    files = [dict(**{key:value for key,value in entry.items() if key != 'local'}, md5=base64.b64encode(bytes.fromhex(digest(stage / entry['local'], 'md5'))).decode()) for entry in objects]
    result = dict(version=1, checkpointId=checkpoint, archive=descriptor('internal.tar.gz', prefix + '/internal.tar.gz'), manifest=descriptor('manifest.json', prefix + '/manifest.json'), files=files, inventoryDigest=manifest['inventoryDigest'], counts=dict(entries=len(before), userFiles=len(files), databases=len(databases)))
    (stage / 'descriptor.json').write_text(json.dumps(result))
    return result
