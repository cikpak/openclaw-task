"""Recovery scope and streaming inventory. Runtime/staging never live in this root."""
import hashlib, json, os, pathlib, stat
ROOT = pathlib.Path(os.environ.get('RECOVERY_ROOT', '/recovery'))
EXCLUDED = ('cache', 'tmp')
def digest_stream(source, algorithm='sha256'):
    h = hashlib.new(algorithm)
    for block in iter(lambda: source.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()
def digest(path, algorithm='sha256'):
    with open(path, 'rb') as source: return digest_stream(source, algorithm)
def safe_path(value):
    if not isinstance(value, str): raise ValueError('Invalid recovery path')
    p = pathlib.PurePosixPath(value)
    if not value or p.is_absolute() or '..' in p.parts or str(p) != value or '\\' in value: raise ValueError('Unsafe recovery path')
    return p
def validate_link(path, target):
    if not isinstance(target, str) or '\x00' in target: raise ValueError('Invalid symlink')
    normalized = os.path.normpath(target)
    if normalized.startswith('/app/'): return
    resolved = pathlib.Path(os.path.normpath(str(ROOT / path.parent / target)))
    if not resolved.is_relative_to(ROOT): raise ValueError('Escaping recovery symlink')
def excluded(path): return any(path == x or path.startswith(x + '/') for x in EXCLUDED)
def user_roots(config):
    agents = config.get('agents', {})
    workspaces = [agents.get('defaults', {}).get('workspace')]
    workspaces += [entry.get('workspace') for entry in agents.get('entries', {}).values()]
    roots = []
    for workspace in workspaces:
        if not workspace: continue
        path = pathlib.Path(os.path.normpath(workspace))
        if not path.is_relative_to(ROOT): raise ValueError('Workspace escapes recovery')
        relative = (path / 'documents').relative_to(ROOT).as_posix(); safe_path(relative)
        if relative not in roots: roots.append(relative)
    return sorted(roots)
def is_user(path, roots): return any(path.startswith(root + '/') for root in roots)
def inventory(base=ROOT):
    result = []
    def walk(directory):
        for item in sorted(directory.iterdir()):
            relative = item.relative_to(base).as_posix()
            if excluded(relative): continue
            s = item.lstat(); entry = dict(path=relative, mode=stat.S_IMODE(s.st_mode), uid=s.st_uid, gid=s.st_gid)
            if stat.S_ISLNK(s.st_mode): entry.update(kind='symlink', target=os.readlink(item)); validate_link(safe_path(relative), entry['target'])
            elif stat.S_ISDIR(s.st_mode): entry['kind'] = 'directory'
            elif stat.S_ISREG(s.st_mode): entry.update(kind='file', size=s.st_size, sha256=digest(item))
            else: raise ValueError('Unsupported special file in recovery')
            result.append(entry)
            if entry['kind'] == 'directory': walk(item)
    walk(base)
    return sorted(result, key=lambda entry: entry['path'])
def inventory_digest(entries): return hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
def root_metadata():
    s = ROOT.stat(); return dict(mode=stat.S_IMODE(s.st_mode), uid=s.st_uid, gid=s.st_gid)
def apply_metadata(path, entry):
    os.chown(path, entry['uid'], entry['gid'], follow_symlinks=False)
    if entry['kind'] != 'symlink': os.chmod(path, entry['mode'])
