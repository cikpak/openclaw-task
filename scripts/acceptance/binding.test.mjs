import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aftercaseBinding } from '../../e2e/aftercase-binding.ts';

const namespace = 'abcdef123456';
const guide = 'Guide this work instead';
const parent = 'LONG_RESPONSE_FIXTURE steering target';
const unavailable = 'The isolated accepted-input binding is unavailable.';
const createDatabase = String.raw`
import json, sqlite3, sys
try:
    fixture = json.load(sys.stdin)
    db = sqlite3.connect(sys.argv[1])
    db.executescript('''CREATE TABLE chats(id TEXT PRIMARY KEY);
      CREATE TABLE command_requests(id TEXT PRIMARY KEY,json TEXT);
      CREATE TABLE command_results(id TEXT PRIMARY KEY,json TEXT);''')
    db.executemany('INSERT INTO chats VALUES(?)', [(value,) for value in fixture['chats']])
    for row in fixture['commands']:
        db.execute('INSERT INTO command_requests VALUES(?,?)', (row['id'],json.dumps(row['command'])))
        if row['result'] is not None:
            db.execute('INSERT INTO command_results VALUES(?,?)', (row['id'],json.dumps(row['result'])))
    db.commit()
    db.close()
except Exception:
    sys.exit(1)
`;

function command(chatId, text) {
  const id = randomUUID();
  return {
    id,
    command: {
      type: 'conversation.message.send',
      commandId: id,
      chatId,
      text,
    },
    result: { commandId: id, ok: true, data: { messageId: id } },
  };
}

async function fixture(t, mutate = () => {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'acceptance-binding-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const directory = join(
    stateDir,
    'v3',
    'do',
    `openclaw-local-${namespace}-manager-ConversationManager`,
  );
  await mkdir(directory, { recursive: true });
  const database = join(directory, `${'d'.repeat(64)}.sqlite`);
  const chatId = randomUUID();
  const input = command(chatId, guide);
  const target = command(chatId, parent);
  const data = { chats: [chatId], commands: [target, input] };
  mutate(data, { input, target });
  await new Promise((resolve, reject) => {
    const child = execFile(
      'python3',
      ['-c', createDatabase, database],
      { timeout: 15_000, maxBuffer: 4096 },
      (error) =>
        error
          ? reject(new Error('Synthetic binding database creation failed.'))
          : resolve(),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(data));
  });
  return { stateDir, directory, database, chatId, input, target };
}

async function rejectsBinding(value, selectedNamespace = namespace) {
  await assert.rejects(
    aftercaseBinding(value.stateDir, selectedNamespace),
    (error) => {
      assert.equal(error.message, unavailable);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
}

test('binds the actual hexadecimal SQLite filename and ignores deleted-chat history read-only', async (t) => {
  const value = await fixture(t, (data) => {
    const deletedChat = randomUUID();
    data.commands.push(
      command(deletedChat, guide),
      command(deletedChat, parent),
      command(data.chats[0], 'Unrelated accepted input'),
    );
  });
  await writeFile(join(value.directory, 'metadata.sqlite'), 'not a manager DB');
  const digest = async () =>
    createHash('sha256')
      .update(await readFile(value.database))
      .digest('hex');
  const before = { hash: await digest(), stat: await stat(value.database) };
  const bound = await aftercaseBinding(value.stateDir, namespace);
  assert.ok(bound.chatId === value.chatId, 'selects the live chat');
  assert.ok(
    bound.commandId === value.input.id,
    'binds the exact guide command',
  );
  assert.ok(
    bound.parentCommandId === value.target.id,
    'binds the exact parent command',
  );
  assert.equal(await digest(), before.hash, 'does not alter database bytes');
  assert.equal(
    (await stat(value.database)).mtimeMs,
    before.stat.mtimeMs,
    'does not write the database',
  );
});

const invalidFixtures = [
  [
    'duplicate live guide',
    (data) => data.commands.push(command(data.chats[0], guide)),
  ],
  [
    'guide and parent in different live chats',
    (data, { input }) => {
      const other = randomUUID();
      data.chats.push(other);
      input.command.chatId = other;
    },
  ],
  [
    'request command identity mismatch',
    (_data, { input }) => {
      input.command.commandId = randomUUID();
    },
  ],
  [
    'result command identity mismatch',
    (_data, { input }) => {
      input.result.commandId = randomUUID();
    },
  ],
  [
    'result message identity mismatch',
    (_data, { input }) => {
      input.result.data.messageId = randomUUID();
    },
  ],
  [
    'unaccepted result',
    (_data, { input }) => {
      input.result.ok = false;
    },
  ],
  [
    'missing accepted result',
    (_data, { input }) => {
      input.result = null;
    },
  ],
  [
    'non-send command',
    (_data, { input }) => {
      input.command.type = 'conversation.message.edit';
    },
  ],
  [
    'deleted only chat',
    (data) => {
      data.chats.length = 0;
    },
  ],
];

for (const [name, mutate] of invalidFixtures) {
  test(`rejects ${name} without leaking binding details`, async (t) => {
    await rejectsBinding(await fixture(t, mutate));
  });
}

test('rejects ambiguous manager databases', async (t) => {
  const value = await fixture(t);
  await writeFile(
    join(value.directory, `${'e'.repeat(64)}.sqlite`),
    'ambiguous',
  );
  await rejectsBinding(value);
});

test('does not bind a different isolated namespace', async (t) => {
  await rejectsBinding(await fixture(t), 'fedcba654321');
});
