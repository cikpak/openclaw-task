import { expect, it, vi } from 'vitest';
import { NativeAttachments } from './attachments.js';
import { DELIVERY_GUIDANCE } from './delivery-guidance.js';
import { NativeGateway } from '../gateway/native.js';
import type { GatewayHistory } from '../../../../backend/src/gateway/types.js';
const mapping = { agentId: 'existing', sessionKey: 'agent:existing:main' };
function storage() {
  const rows = new Map<string, unknown>();
  const read = vi.fn((key: string) => Promise.resolve(rows.get(key)));
  return {
    rows,
    read,
    get: <T>(key: string) => read(key).then((value) => value as T | undefined),
    put: vi.fn(<T>(key: string, value: T) => {
      rows.set(key, structuredClone(value));
      return Promise.resolve();
    }),
    delete: (key: string) => Promise.resolve(rows.delete(key)),
  };
}
const history = (text: string, runId = 'input', role = 'user') =>
  ({ messages: [{ id: 'message', role, text, runId }] }) as GatewayHistory;
it('delivers current context to an existing native session without reading or rewriting frozen AGENTS instructions', async () => {
  const state = storage();
  const gateway = new NativeGateway({
    storage: state,
    gatewayToken: 'private-test-token',
    pair: () => Promise.resolve(),
    fetcher: () => {
      throw new Error('No network');
    },
  });
  const request = vi
    .spyOn(gateway, 'request')
    .mockResolvedValue({ runId: 'input', status: 'started' });
  const prepared = await gateway.prepareSend(
    mapping,
    'input',
    'Generate a joke report',
    [],
  );
  expect(prepared.text).toContain(DELIVERY_GUIDANCE);
  expect(prepared.text).toContain('documents/<safe-filename>');
  expect(prepared.attachments).toEqual([]);
  const fresh = await new NativeAttachments(state).prepare(
    mapping,
    'input',
    'Generate a joke report',
    [],
  );
  expect(fresh).toEqual(prepared);
  expect(
    (
      await new NativeAttachments(state).history(
        mapping,
        history(prepared.text),
      )
    ).messages[0]?.text,
  ).toBe('Generate a joke report');
  // Invocation must not await persistence or other preflight work after the service's ownership fence.
  state.read.mockClear();
  state.put.mockClear();
  const acknowledgement = gateway.send(
    mapping,
    'input',
    prepared.text,
    'queue',
    prepared.attachments,
  );
  expect(request).toHaveBeenCalledExactlyOnceWith(
    'chat.send',
    expect.objectContaining({
      sessionKey: mapping.sessionKey,
      agentId: mapping.agentId,
      idempotencyKey: 'input',
      message: prepared.text,
      queueMode: 'followup',
    }),
  );
  expect(state.read).not.toHaveBeenCalled();
  expect(state.put).not.toHaveBeenCalled();
  expect(await acknowledgement).toMatchObject({ runId: 'input' });
});
it('uses the same per-submission context across recreation and gives later requests their own stable marker', async () => {
  const state = storage();
  const first = await new NativeAttachments(state).prepare(
    mapping,
    'input',
    'First request',
    [],
  );
  const again = await new NativeAttachments(state).prepare(
    mapping,
    'input',
    'First request',
    [],
  );
  expect(again).toEqual(first);
  const second = await new NativeAttachments(state).prepare(
    mapping,
    'next',
    'Second request',
    [],
  );
  expect(second.text).toContain(DELIVERY_GUIDANCE);
  expect(second.text.slice('Second request'.length)).not.toBe(
    first.text.slice('First request'.length),
  );
});
it('retains legacy attachment retries byte for byte and strips their existing private appendix', async () => {
  const state = storage();
  const marker = crypto.randomUUID();
  const suffix = `\n\n[messenger-attachments:${marker}]\nLegacy input instructions\n[/messenger-attachments]`;
  const attachment = {
    uploadId: 'upload',
    name: 'Original.txt',
    mimeType: 'text/plain',
    size: 8,
  };
  const record = {
    suffix,
    marker,
    submissionId: 'input',
    attachments: [attachment],
  };
  await state.put(`attachment-appendix:${mapping.sessionKey}:input`, record);
  await state.put(`attachment-marker:${mapping.sessionKey}:${marker}`, record);
  const adapter = new NativeAttachments(state);
  const prepared = await adapter.prepare(
    mapping,
    'input',
    'Legacy request',
    [],
  );
  expect(prepared.text).toBe('Legacy request' + suffix);
  expect(prepared.text).not.toContain(DELIVERY_GUIDANCE);
  expect(
    (await adapter.history(mapping, history(prepared.text))).messages[0],
  ).toMatchObject({ text: 'Legacy request', attachments: [attachment] });
});
it('strips only an exact persisted user suffix for the matching session and submission', async () => {
  const state = storage();
  const adapter = new NativeAttachments(state);
  const user = `User-authored marker:\n\n[messenger-attachments:${crypto.randomUUID()}]\nKeep this text.`;
  const prepared = await adapter.prepare(mapping, 'input', user, []);
  expect(
    (await adapter.history(mapping, history(prepared.text))).messages[0]?.text,
  ).toBe(user);
  for (const raw of [
    history(prepared.text, 'other-input'),
    history(prepared.text, 'input', 'assistant'),
    history(prepared.text + ' changed'),
  ])
    expect(await adapter.history(mapping, raw)).toEqual(raw);
  expect(
    await adapter.history(
      { ...mapping, sessionKey: 'agent:foreign:main' },
      history(prepared.text),
    ),
  ).toEqual(history(prepared.text));
});
it('does not invoke the native sender when durable context preparation fails', async () => {
  const state = storage();
  state.put.mockRejectedValueOnce(new Error('Durable storage unavailable'));
  const gateway = new NativeGateway({
    storage: state,
    gatewayToken: 'test',
    pair: () => Promise.resolve(),
    fetcher: () => {
      throw new Error('No network');
    },
  });
  const request = vi.spyOn(gateway, 'request');
  const submit = async () => {
    const prepared = await gateway.prepareSend(
      mapping,
      'input',
      'Generate a file',
      [],
    );
    return gateway.send(
      mapping,
      'input',
      prepared.text,
      'queue',
      prepared.attachments,
    );
  };
  await expect(submit()).rejects.toThrow('Durable storage unavailable');
  expect(request).not.toHaveBeenCalled();
});
