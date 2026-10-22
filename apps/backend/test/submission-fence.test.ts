import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/database.js';
import { ChatService, mapping } from '../src/chats/service.js';
import { boundedPending } from '../src/chats/projection.js';
import { parseOutboundEvent } from '../src/outbound.js';
import { FakeGateway, testSettings } from './fake-gateway.js';

function gate() {
  let release!: () => void;
  let enter!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  return {
    release,
    entered,
    wait: async () => {
      enter();
      await blocked;
    },
  };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0)) await clean();
});

async function fixture(
  stage: 'history' | 'media' | 'guidance',
  behavior: 'queue' | 'steer' = 'queue',
  failPreparation = false,
) {
  const store = new Store(':memory:');
  const gateway = new FakeGateway();
  const latch = gate();
  const attachment = {
    uploadId: randomUUID(),
    name: 'note.txt',
    mimeType: 'text/plain',
    size: 1,
  };
  const payload = vi.fn(() => Promise.resolve([]));
  const service = new ChatService(store, gateway, {
    prepare: () => Promise.resolve([attachment]),
    payload,
  });
  cleanup.push(async () => {
    latch.release();
    await nextTurn();
    service.close();
    await service.drain();
    store.close();
  });
  const chat = await service.create({
    commandId: randomUUID(),
    settings: testSettings,
  });
  await service.drain();
  const target = mapping(store.getChat(chat.id));
  if (behavior === 'steer') {
    await service.command({
      type: 'conversation.message.send',
      commandId: randomUUID(),
      chatId: chat.id,
      text: 'active',
    });
    await service.drain();
    gateway.sends.length = 0;
  }
  if (stage === 'history') {
    const history = gateway.history.bind(gateway);
    vi.spyOn(gateway, 'history').mockImplementationOnce(async (...args) => {
      const result = structuredClone(await history(...args));
      await latch.wait();
      if (failPreparation) throw new Error('late history failure');
      // History need not supply a session ID: a foreign-key failure is not a submission fence.
      return { ...result, sessionId: undefined };
    });
  } else if (stage === 'media')
    payload.mockImplementationOnce(async () => {
      await latch.wait();
      if (failPreparation) throw new Error('late media failure');
      return [];
    });
  else
    Object.assign(gateway, {
      prepareSend: async (scope: typeof target) => {
        expect(scope).toEqual(target);
        await latch.wait();
        if (failPreparation) throw new Error('late guidance failure');
      },
    });
  const command = {
    type: 'conversation.message.send' as const,
    commandId: randomUUID(),
    chatId: chat.id,
    text: 'suspended',
    behavior,
    ...(stage === 'media' ? { uploadIds: [attachment.uploadId] } : {}),
  };
  expect((await service.command(command)).ok).toBe(true);
  await latch.entered;
  const abort = async () => {
    expect(
      (
        await service.command({
          type: 'conversation.run.abort',
          commandId: randomUUID(),
          chatId: chat.id,
        })
      ).ok,
    ).toBe(true);
    expect(
      service.pending(chat.id).find((item) => item.id === command.commandId)
        ?.state,
    ).toBe('unknown');
  };
  const resolve = (action: 'discard' | 'retry') =>
    service.command({
      type: 'conversation.message.resolveUnknown',
      commandId: randomUUID(),
      chatId: chat.id,
      messageId: command.commandId,
      revision: 1,
      action,
    });
  const finish = async () => {
    latch.release();
    await nextTurn();
    await service.drain();
  };
  return {
    store,
    gateway,
    service,
    chat,
    target,
    latch,
    command,
    abort,
    resolve,
    finish,
    payload,
  };
}

describe('submission ownership at the Gateway invocation boundary', () => {
  // Value: steer-to-queue fallback retains every accepted input without overflowing snapshots.
  // Regression: 42 suspended steers became pending and escaped the public 41-item display bound.
  it('bounds disconnected steer fallback while retaining and later dispatching all durable inputs', async () => {
    const f = await fixture('media', 'steer');
    f.payload.mockImplementation(async () => {
      await f.latch.wait();
      return [];
    });
    for (let index = 1; index < 42; index++) {
      expect(
        (
          await f.service.command({
            ...f.command,
            commandId: randomUUID(),
            text: `retained steer ${index}`,
          })
        ).ok,
      ).toBe(true);
    }
    const snapshots: number[] = [];
    f.service.onEvent((event) => {
      if (event.type === 'conversation.snapshot') {
        expect(() => parseOutboundEvent(event)).not.toThrow();
        snapshots.push(event.snapshot.pending.length);
      }
    });
    f.gateway.ready = false;
    f.gateway.emit({ type: 'connection', ready: false });
    await f.finish();
    expect(f.gateway.sends).toHaveLength(0);
    const retained = f.service
      .pending(f.chat.id)
      .filter((item) => item.state === 'pending');
    expect(retained).toHaveLength(42);
    const projected = boundedPending(f.store, f.chat.id);
    expect(projected.pending).toHaveLength(21);
    expect(projected.hiddenPendingCount).toBe(22);
    expect((await f.service.snapshot(f.chat.id)).pending).toHaveLength(21);
    expect(snapshots.every((count) => count <= 41)).toBe(true);
    expect(snapshots.length).toBeGreaterThan(0);
    const active = f.gateway.histories.get(f.target.sessionKey);
    if (!active) throw new Error('Missing active history');
    active.activeRun = null;
    for (const receipt of active.receipts) receipt.state = 'consumed';
    f.gateway.ready = true;
    await f.service.reconcile();
    await f.service.drain();
    expect(f.gateway.sends.map((entry) => entry.id)).toEqual([retained[0]?.id]);
    expect(f.service.pending(f.chat.id)).toHaveLength(42);
    for (const item of retained) {
      expect(f.gateway.sends.at(-1)?.id).toBe(item.id);
      f.gateway.complete(f.target, item.submissionId);
      await nextTurn();
      await f.service.drain();
    }
    expect(f.gateway.sends.map((entry) => entry.id)).toEqual(
      retained.map((item) => item.id),
    );
    expect(f.service.pending(f.chat.id)).toHaveLength(0);
  });

  // Value: successful explicit discard must prevent a send that has never reached Gateway.
  // Regression: preparation used to resume into an unconditional send for a removed row.
  it.each([
    ['history', 'queue'],
    ['media', 'queue'],
    ['history', 'steer'],
    ['media', 'steer'],
    ['guidance', 'queue'],
    ['guidance', 'steer'],
  ] as const)(
    'fences discarded %s preparation for %s sends',
    async (stage, behavior) => {
      const f = await fixture(stage, behavior);
      await f.abort();
      expect((await f.resolve('discard')).ok).toBe(true);
      expect(f.service.pending(f.chat.id)).toHaveLength(0);
      expect(f.gateway.sends).toHaveLength(0);
      await f.finish();
      expect(f.gateway.sends).toHaveLength(0);
      expect(f.service.pending(f.chat.id)).toHaveLength(0);
      expect(f.store.getChat(f.chat.id).status).toBe('idle');
    },
  );

  // Value: explicit retry authorizes the new revision, never the suspended old attempt.
  it.each(['queue', 'steer'] as const)(
    'submits only the retried revision after blocked %s preparation resumes',
    async (behavior) => {
      const f = await fixture('media', behavior);
      await f.abort();
      expect((await f.resolve('retry')).ok).toBe(true);
      await f.finish();
      expect(f.gateway.sends.map((entry) => entry.id)).toEqual([
        f.command.commandId,
      ]);
      expect(f.service.pending(f.chat.id)[0]).toMatchObject({
        revision: 2,
        state: 'submitted',
      });
    },
  );

  // Value: stale preflight errors cannot resurrect discarded work or overwrite recovery choices.
  it.each(['media', 'guidance'] as const)(
    'retains unknown state when blocked %s preparation fails after abort',
    async (stage) => {
      const f = await fixture(stage, 'queue', true);
      await f.abort();
      await f.finish();
      expect(f.service.pending(f.chat.id)[0]?.state).toBe('unknown');
      expect(f.gateway.sends).toHaveLength(0);
      expect(f.store.getChat(f.chat.id).status).toBe('recovery');
    },
  );

  // Value: recovery followed by edit/cancel cannot revive the old revision's content.
  it.each(['edit', 'cancel'] as const)(
    'honors %s of the retried queue item before old preparation resumes',
    async (operation) => {
      const f = await fixture('media');
      await f.abort();
      expect((await f.resolve('retry')).ok).toBe(true);
      const identity = {
        commandId: randomUUID(),
        chatId: f.chat.id,
        messageId: f.command.commandId,
        revision: 2,
      };
      expect(
        (
          await f.service.command(
            operation === 'edit'
              ? {
                  ...identity,
                  type: 'conversation.message.editQueued',
                  text: 'corrected retry',
                }
              : { ...identity, type: 'conversation.message.cancelQueued' },
          )
        ).ok,
      ).toBe(true);
      await f.finish();
      expect(f.gateway.sends.map((entry) => entry.text)).toEqual(
        operation === 'edit' ? ['corrected retry'] : [],
      );
      if (operation === 'edit')
        expect(f.service.pending(f.chat.id)[0]).toMatchObject({
          revision: 3,
          state: 'submitted',
        });
      else expect(f.service.pending(f.chat.id)).toHaveLength(0);
    },
  );

  // Value: the network ACK wait must permit recovery; stale results must preserve its new revision.
  it.each(['accept', 'reject'] as const)(
    'does not overwrite an explicit retry with a late %s ACK',
    async (outcome) => {
      const f = await fixture('media');
      const ack = gate();
      cleanup.unshift(() => {
        ack.release();
        return Promise.resolve();
      });
      vi.spyOn(f.gateway, 'send').mockImplementationOnce(async () => {
        await ack.wait();
        if (outcome === 'reject') throw new Error('late ACK failure');
        return { runId: f.command.commandId, status: 'accepted' };
      });
      f.latch.release();
      await ack.entered;
      // A lock held until ACK would hang this command instead of allowing it to complete.
      await f.abort();
      expect((await f.resolve('retry')).ok).toBe(true);
      ack.release();
      await f.finish();
      expect(f.gateway.sends.map((entry) => entry.id)).toEqual([
        f.command.commandId,
      ]);
      expect(f.service.pending(f.chat.id)[0]).toMatchObject({
        revision: 2,
        state: 'submitted',
      });
    },
  );

  // Value: cancellation fences are selective; unrelated durable queued work still progresses.
  it('dispatches legitimate queued work after discarding the suspended item', async () => {
    const f = await fixture('media');
    const nextId = randomUUID();
    expect(
      (
        await f.service.command({
          type: 'conversation.message.send',
          commandId: nextId,
          chatId: f.chat.id,
          text: 'legitimate queued input',
        })
      ).ok,
    ).toBe(true);
    await f.abort();
    expect((await f.resolve('discard')).ok).toBe(true);
    await f.finish();
    await vi.waitFor(() =>
      expect(f.gateway.sends.map((entry) => entry.id)).toEqual([nextId]),
    );
  });

  // Value: shutdown and deletion cannot launch fresh upstream work after asynchronous preparation.
  it.each(['close', 'delete', 'cancel-work'] as const)(
    'fences a %s transition while media preparation is blocked',
    async (transition) => {
      const f = await fixture('media');
      if (transition === 'close') f.service.close();
      else if (transition === 'delete')
        await f.service.delete(
          f.chat.id,
          `"${f.store.getChat(f.chat.id).version}"`,
        );
      else
        await f.service.updateSettings(
          f.chat.id,
          { ...testSettings, fastMode: true },
          'cancel-work',
          `"${f.store.getChat(f.chat.id).version}"`,
        );
      await f.finish();
      expect(f.gateway.sends).toHaveLength(0);
      if (transition === 'close')
        expect(f.service.pending(f.chat.id)).toHaveLength(1);
      else if (transition === 'delete')
        expect(() => f.store.getChat(f.chat.id)).toThrow();
      else {
        expect(f.service.pending(f.chat.id)).toHaveLength(0);
        expect(f.store.settingsOperation(f.chat.id)).toBeNull();
        expect(f.store.getChat(f.chat.id).settings.fastMode).toBe(true);
      }
    },
  );

  // Value: when-idle settings preserve already-authorized queue execution under the old settings.
  it('continues claimed durable work through a when-idle settings request', async () => {
    const f = await fixture('media');
    await f.service.updateSettings(
      f.chat.id,
      { ...testSettings, fastMode: true },
      'when-idle',
      `"${f.store.getChat(f.chat.id).version}"`,
    );
    await f.finish();
    expect(f.gateway.sends.map((entry) => entry.id)).toEqual([
      f.command.commandId,
    ]);
    expect(f.store.settingsOperation(f.chat.id)?.status).toBe('pending');
  });

  // Value: connection loss retains definitely unsent work for a later valid dispatcher claim.
  it('retains blocked durable work while Gateway is unavailable and dispatches after recovery', async () => {
    const f = await fixture('media');
    f.gateway.ready = false;
    await f.finish();
    expect(f.gateway.sends).toHaveLength(0);
    expect(f.service.pending(f.chat.id)[0]?.state).toBe('pending');
    f.gateway.ready = true;
    await f.service.reconcile();
    await f.service.drain();
    expect(f.gateway.sends.map((entry) => entry.id)).toEqual([
      f.command.commandId,
    ]);
  });

  // Value: drain provides deterministic shutdown ownership for detached steer preparation.
  it('waits for a suspended steer submission during drain', async () => {
    const f = await fixture('media', 'steer');
    let drained = false;
    const drain = f.service.drain().then(() => {
      drained = true;
    });
    await nextTurn();
    expect(drained).toBe(false);
    await f.finish();
    await drain;
    expect(f.gateway.sends).toHaveLength(1);
  });
});
