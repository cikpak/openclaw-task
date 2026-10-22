import { expect, it, vi } from 'vitest';
import { ChatService, mapping } from '../src/chats/service.js';
import { abortAcceptedInputs } from '../src/chats/cancellations.js';
import { exactCallerFixture } from './native-exact-abort-fixture.js';
import { testSettings } from './fake-gateway.js';

async function caller() {
  const f = await exactCallerFixture();
  const history = f.gateway.histories.get(mapping(f.chat).sessionKey)!;
  history.nativeInputOwners = [];
  Object.assign(f.gateway, {
    abortChat: vi.fn(() => {
      history.activeRun = null;
      return Promise.resolve({
        runIds: ['input'],
        inputs: [
          {
            kind: 'pre-execution-input-cancelled',
            inputId: 'input',
            sessionId: history.sessionId,
            ...mapping(f.chat),
          },
        ],
      });
    }),
  });
  f.abort.mockImplementation(() =>
    Promise.resolve({ abortedRunId: 'unrelated' }),
  );
  return f;
}

it.each(['Stop', 'cancel-work'])(
  'settles the exact certified input through real %s caller without replay',
  async (action) => {
    const f = await caller();
    if (action === 'Stop') {
      expect(
        await f.service.command({
          type: 'conversation.run.abort',
          commandId: crypto.randomUUID(),
          chatId: f.chat.id,
        }),
      ).toMatchObject({ ok: true });
    } else {
      await f.service.updateSettings(
        f.chat.id,
        { ...testSettings, fastMode: true },
        'cancel-work',
        `"${f.chat.version}"`,
      );
      await f.service.drain();
      expect(f.store.settingsOperation(f.chat.id)).toBeNull();
      expect(f.store.getChat(f.chat.id).settings.fastMode).toBe(true);
    }
    expect(f.abortRun).not.toHaveBeenCalled();
    expect(f.store.pending(f.chat.id)).toEqual([]);
    expect(f.gateway.sends).toEqual([]);
    const snapshot = JSON.stringify(f.service.cachedSnapshot(f.chat.id));
    expect(snapshot).not.toContain('pre-execution-input-cancelled');
    expect(snapshot).not.toContain('request_id');
    expect(snapshot).not.toContain('inputCancellationRequests');
  },
);

it('uses only durable SQL cancellation authority after service recreation', async () => {
  const f = await caller();
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  expect(f.store.pending(f.chat.id)).toHaveLength(1);
  f.service.close();
  await f.service.drain();
  const next = new ChatService(f.store, f.gateway, undefined, {
    backgroundReconciliation: false,
  });
  try {
    expect(next.terminalRuns.size).toBe(0);
    await next.reconcile();
    await next.drain();
    expect(f.store.pending(f.chat.id)).toEqual([]);
    expect(f.gateway.sends).toEqual([]);
  } finally {
    next.close();
    await next.drain();
  }
});
