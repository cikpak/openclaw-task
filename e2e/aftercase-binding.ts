import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const bindingScript = String.raw`
import json, pathlib, re, sqlite3, sys, urllib.parse
try:
    state, namespace = sys.argv[1:]
    if not re.fullmatch(r'[a-f0-9]{12}', namespace): raise ValueError()
    root = pathlib.Path(state).resolve(strict=True)
    directory = root / 'v3' / 'do' / ('openclaw-local-' + namespace + '-manager-ConversationManager')
    if directory.is_symlink() or directory.resolve(strict=True).parent != (root / 'v3' / 'do').resolve(strict=True): raise ValueError()
    files = [p for p in directory.glob('*.sqlite') if re.fullmatch(r'[a-f0-9]{64}\.sqlite', p.name) and not p.is_symlink()]
    if len(files) != 1: raise ValueError()
    uri = 'file:' + urllib.parse.quote(str(files[0]), safe='/') + '?mode=ro'
    db = sqlite3.connect(uri, uri=True, timeout=2)
    db.execute('PRAGMA query_only=ON')
    db.execute('BEGIN')
    guide = 'Guide this work instead'
    parent = 'LONG_RESPONSE_FIXTURE steering target'
    rows = db.execute('''SELECT c.id,q.id,q.json,r.json FROM command_requests q
      JOIN chats c ON json_extract(q.json,'$.chatId')=c.id
      JOIN command_results r ON r.id=q.id
      WHERE json_extract(q.json,'$.type')='conversation.message.send'
      AND json_extract(q.json,'$.text') IN (?,?)''', (guide,parent)).fetchmany(3)
    if len(rows) != 2: raise ValueError()
    found = {}
    uuid = re.compile(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}')
    for chat, identity, raw, result in rows:
        command, accepted = json.loads(raw), json.loads(result)
        label = command.get('text')
        if label not in (guide,parent) or label in found: raise ValueError()
        if not uuid.fullmatch(chat) or not uuid.fullmatch(identity): raise ValueError()
        if command.get('commandId') != identity or command.get('chatId') != chat: raise ValueError()
        if accepted.get('ok') is not True or accepted.get('commandId') != identity: raise ValueError()
        if accepted.get('data',{}).get('messageId') != identity: raise ValueError()
        found[label] = (chat,identity)
    if set(found) != {guide,parent} or found[guide][0] != found[parent][0]: raise ValueError()
    db.close()
    # Private pipe only: the caller never logs, attaches or persists these identities.
    sys.stdout.write(json.dumps({'chatId':found[guide][0], 'commandId':found[guide][1], 'parentCommandId':found[parent][1]}))
except Exception:
    sys.exit(1)
`;

/** Bind only existing accepted commands in the exact current isolated namespace. */
export async function aftercaseBinding(stateDir: string, namespace: string) {
  try {
    const { stdout } = await promisify(execFile)(
      'python3',
      ['-c', bindingScript, stateDir, namespace],
      { timeout: 15_000, maxBuffer: 4096 },
    );
    const value = JSON.parse(stdout) as Record<string, unknown>;
    const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
    const keys = ['chatId', 'commandId', 'parentCommandId'] as const;
    if (
      keys.some(
        (key) => typeof value[key] !== 'string' || !uuid.test(value[key]),
      )
    )
      throw new Error();
    return {
      chatId: String(value.chatId),
      commandId: String(value.commandId),
      parentCommandId: String(value.parentCommandId),
    };
  } catch {
    throw new Error('The isolated accepted-input binding is unavailable.');
  }
}
