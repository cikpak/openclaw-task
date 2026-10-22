import json, os, pathlib, shutil, tarfile, tempfile, re
from snapshot_common import ROOT, EXCLUDED, safe_path, validate_link, excluded, inventory, inventory_digest, digest, digest_stream, apply_metadata
from snapshot_sqlite import database_checks

def validate_manifest(manifest, descriptor):
    entries = manifest['inventory']
    if manifest.get('version') != 1 or manifest['checkpointId'] != descriptor['checkpointId'] or inventory_digest(entries) != descriptor['inventoryDigest'] or manifest['inventoryDigest'] != descriptor['inventoryDigest']: raise ValueError('Manifest mismatch')
    if manifest['excluded'] != list(EXCLUDED) or manifest['compatibility'] != dict(openclaw='2026.10.1', format='messenger-1'): raise ValueError('Unsupported recovery version')
    mapping = {}
    for entry in entries:
        p = safe_path(entry['path'])
        if entry['path'] in mapping or excluded(entry['path']): raise ValueError('Duplicate or excluded path')
        if any(type(entry[name]) != int or not 0 <= entry[name] <= (4095 if name == 'mode' else 4294967294) for name in ('mode', 'uid', 'gid')): raise ValueError('Invalid ownership or mode')
        if entry['kind'] not in ('file', 'directory', 'symlink'): raise ValueError('Invalid entry kind')
        if entry['kind'] == 'symlink': validate_link(p, entry['target'])
        mapping[entry['path']] = entry
    for path in mapping:
        for parent in pathlib.PurePosixPath(path).parents:
            if str(parent) != '.' and mapping.get(str(parent), {}).get('kind') != 'directory': raise ValueError('Non-directory ancestor')
    return entries, mapping

def validate_objects(stage, manifest, descriptor, mapping):
    files = manifest['files']; file_entries = {entry['path']:entry for entry in files}
    if len(file_entries) != len(files): raise ValueError('Duplicate file mapping')
    if [{key:value for key,value in entry.items() if key != 'md5'} for entry in descriptor['files']] != [{key:value for key,value in entry.items() if key != 'local'} for entry in files]: raise ValueError('Descriptor mapping mismatch')
    for path, item in file_entries.items():
        entry = mapping.get(path)
        if not entry or entry['kind'] != 'file' or item['local'] != 'user-' + entry['sha256'] or not re.fullmatch(r'files/(?:[A-Za-z0-9_-]{1,80}/)?' + entry['sha256'], item['key']): raise ValueError('Invalid user file mapping')
        source = stage / item['local']
        if source.stat().st_size != entry['size'] or digest(source) != entry['sha256']: raise ValueError('User file hash mismatch')
    expected = {path:entry for path,entry in mapping.items() if path not in file_entries}
    with tarfile.open(stage / 'internal.tar.gz', 'r:gz') as archive:
        seen = set()
        for member in archive:
            path = str(safe_path(member.name)); entry = expected.get(path)
            if not entry or path in seen or member.mode != entry['mode'] or member.uid != entry['uid'] or member.gid != entry['gid']: raise ValueError('Unexpected archive member')
            seen.add(path)
            if entry['kind'] == 'directory' and not member.isdir(): raise ValueError('Wrong archive directory')
            if entry['kind'] == 'symlink' and (not member.issym() or member.linkname != entry['target']): raise ValueError('Wrong archive symlink')
            if entry['kind'] == 'file':
                if not member.isfile() or member.size != entry['size']: raise ValueError('Wrong archive file')
                with archive.extractfile(member) as source:
                    if digest_stream(source) != entry['sha256']: raise ValueError('Archive hash mismatch')
        if seen != set(expected): raise ValueError('Missing archive members')
    return file_entries

def restore(stage, descriptor):
    manifest = json.loads((stage / 'manifest.json').read_text()); entries, mapping = validate_manifest(manifest, descriptor)
    files = validate_objects(stage, manifest, descriptor, mapping)
    root = manifest['root']
    if any(type(root[name]) != int or not 0 <= root[name] <= (4095 if name == 'mode' else 4294967294) for name in ('mode', 'uid', 'gid')): raise ValueError('Invalid root metadata')
    if list(ROOT.iterdir()): raise ValueError('Restore root must be empty')
    needed = sum(entry.get('size', 0) for entry in entries) + 32 * 1024 * 1024
    if shutil.disk_usage(stage).free < needed: raise ValueError('Insufficient restore capacity')
    with tempfile.TemporaryDirectory(prefix='verified-', dir=stage.parent) as temporary:
        target = pathlib.Path(temporary)
        for entry in entries:
            if entry['kind'] == 'directory': (target / entry['path']).mkdir(parents=True, mode=0o700)
        with tarfile.open(stage / 'internal.tar.gz', 'r:gz') as archive:
            for member in archive:
                entry = mapping[member.name]; path = target / entry['path']
                if entry['kind'] == 'file':
                    with archive.extractfile(member) as source, open(path, 'xb') as destination: shutil.copyfileobj(source, destination, length=1024 * 1024)
                elif entry['kind'] == 'symlink': os.symlink(entry['target'], path)
        for path, item in files.items(): shutil.copyfile(stage / item['local'], target / path)
        for entry in reversed(entries): apply_metadata(target / entry['path'], entry)
        if inventory(target) != entries: raise ValueError('Restored inventory mismatch')
        databases = database_checks(entries, target)
        # All contents and SQLite clones verified before installing any recovery bytes.
        for child in target.iterdir(): os.rename(child, ROOT / child.name)
        os.chown(ROOT, root['uid'], root['gid']); os.chmod(ROOT, root['mode'])
    return dict(restored=True, inventoryDigest=inventory_digest(entries), entries=len(entries), databases=databases, userFiles=len(files))
