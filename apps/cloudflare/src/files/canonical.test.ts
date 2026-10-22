import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ChatSettings, ManagerCommand } from '@messenger/contracts';
import { Store } from '../../../backend/src/database.js';
import { ValidationError } from '../../../backend/src/errors.js';
import { savePreferences } from '../../../backend/src/chats/preferences.js';
import { BrowserBoundary } from './boundary.js';
import { restoreCanonicalCommand } from './canonical.js';

let store: Store;
const boundary = new BrowserBoundary(() => ({
  documentsRoots: [],
  publications: [],
  secrets: ['private-provider-key'],
}));
const original: ChatSettings = {
  model: 'provider/model-a',
  thinkingLevel: 'low',
  fastMode: false,
  responseStyle: 'default',
  personality: 'neutral',
  customInstructions:
    'Read /recovery/private/notes.txt before replying with private-provider-key',
};
const commandId = () => crypto.randomUUID();
beforeEach(() => {
  store = new Store(':memory:');
  store.reserveChat({
    id: 'chat',
    name: 'Review /recovery/private/team.txt',
    settings: original,
    status: 'idle',
    version: 3,
    createdAt: 1,
    updatedAt: 1,
    unread: false,
    agentId: 'agent',
    sessionKey: 'session',
    creationId: 'creation',
  });
  savePreferences(
    store,
    { busySendBehavior: 'queue', defaults: original },
    '"1"',
  );
  store.savePending({
    id: 'pending',
    chatId: 'chat',
    position: 0,
    text: 'Use /recovery/private/context.txt and private-provider-key',
    attachments: [],
    revision: 2,
    state: 'pending',
    submissionId: 'submission',
    createdAt: 1,
  });
});
afterEach(() => store.close());
function restore<T extends ManagerCommand>(command: T): T {
  return restoreCanonicalCommand(command, store, boundary) as T;
}
it('preserves hidden canonical instructions while changing unrelated model and response style', () => {
  const projected = boundary.project(original);
  expect(projected.customInstructions).toContain('[private reference]');
  expect(projected.customInstructions).toContain('[redacted]');
  const command = {
    type: 'chat.settings.update' as const,
    commandId: commandId(),
    chatId: 'chat',
    version: 3,
    settings: {
      ...projected,
      model: 'provider/model-b',
      responseStyle: 'concise' as const,
    },
    policy: 'when-idle' as const,
  };
  expect(restore(command)).toEqual({
    ...command,
    settings: {
      ...original,
      model: 'provider/model-b',
      responseStyle: 'concise',
    },
  });
  expect(command.settings.customInstructions).toBe(
    projected.customInstructions,
  );
  expect(store.getChat('chat').settings).toEqual(original);
});
it('restores unchanged hidden defaults while updating a visible preference', () => {
  const command = {
    type: 'preferences.update' as const,
    commandId: commandId(),
    version: 2,
    preferences: {
      busySendBehavior: 'steer' as const,
      defaults: { ...boundary.project(original), fastMode: true },
    },
  };
  expect(restore(command)).toEqual({
    ...command,
    preferences: {
      busySendBehavior: 'steer',
      defaults: { ...original, fastMode: true },
    },
  });
});
it('creates a new chat from projected defaults without replacing private native instructions', () => {
  const command = {
    type: 'chat.create' as const,
    commandId: commandId(),
    settings: boundary.project(original),
    initialMessage: { text: 'New work' },
  };
  expect(restore(command)).toEqual({ ...command, settings: original });
});
it('preserves an untouched projected pending message during a queued edit', () => {
  const text = store.pending('chat')[0]!.text;
  const command = {
    type: 'conversation.message.editQueued' as const,
    commandId: commandId(),
    chatId: 'chat',
    messageId: 'pending',
    revision: 2,
    text: boundary.project(text),
    uploadIds: ['new-upload'],
  };
  expect(restore(command)).toEqual({ ...command, text });
  expect(store.pending('chat')[0]!.text).toBe(text);
});
it('preserves a projected name but permits an ordinary new name', () => {
  const name = store.getChat('chat').name;
  const command = {
    type: 'chat.rename' as const,
    commandId: commandId(),
    chatId: 'chat',
    version: 3,
    name: boundary.project(name),
  };
  expect(restore(command).name).toBe(name);
  expect(restore({ ...command, name: 'Visible new name' }).name).toBe(
    'Visible new name',
  );
});
it.each(['customInstructions', 'model'] as const)(
  'rejects partially edited redacted settings field %s with a controlled error',
  (key) => {
    const command = {
      type: 'chat.settings.update' as const,
      commandId: commandId(),
      chatId: 'chat',
      version: 3,
      settings: {
        ...boundary.project(original),
        [key]: 'Changed [redacted] value',
      },
      policy: 'when-idle' as const,
    };
    expect(() => restore(command)).toThrow(ValidationError);
    expect(store.getChat('chat').settings).toEqual(original);
  },
);
it('rejects edited hidden defaults and a partially changed projected pending message', () => {
  expect(() =>
    restore({
      type: 'preferences.update',
      commandId: commandId(),
      version: 2,
      preferences: {
        busySendBehavior: 'queue',
        defaults: {
          ...original,
          customInstructions: 'Changed [private reference]',
        },
      },
    }),
  ).toThrow(ValidationError);
  expect(() =>
    restore({
      type: 'conversation.message.editQueued',
      commandId: commandId(),
      chatId: 'chat',
      messageId: 'pending',
      revision: 2,
      text: `${boundary.project(store.pending('chat')[0]!.text)} with changes`,
    }),
  ).toThrow(ValidationError);
});
it('accepts an explicit full replacement of hidden instructions or queued content', () => {
  const command = {
    type: 'chat.settings.update' as const,
    commandId: commandId(),
    chatId: 'chat',
    version: 3,
    settings: {
      ...original,
      customInstructions: 'Only these new instructions',
    },
    policy: 'when-idle' as const,
  };
  expect(restore(command).settings.customInstructions).toBe(
    'Only these new instructions',
  );
  expect(
    restore({
      type: 'conversation.message.editQueued',
      commandId: commandId(),
      chatId: 'chat',
      messageId: 'pending',
      revision: 2,
      text: 'New public request',
    }).text,
  ).toBe('New public request');
});
it('does not attach another message canonical text to a missing or differently scoped pending ID', () => {
  expect(() =>
    restore({
      type: 'conversation.message.editQueued',
      commandId: commandId(),
      chatId: 'chat',
      messageId: 'other',
      revision: 2,
      text: boundary.project(store.pending('chat')[0]!.text),
    }),
  ).toThrow(ValidationError);
});
it('returns unrelated commands unchanged and never mutates persistence', () => {
  const command = {
    type: 'conversation.message.send' as const,
    commandId: commandId(),
    chatId: 'chat',
    text: 'A literal [redacted] phrase in a new user message',
  };
  expect(restore(command)).toBe(command);
  expect(store.pending('chat')).toHaveLength(1);
});
