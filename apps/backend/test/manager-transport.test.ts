import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { UPLOAD_CHUNK_BYTES } from '@messenger/contracts';
import { managerCommandSchema } from '../src/transport/manager-schema.js';
import {
  ManagerTransport,
  type ManagerHandlers,
} from '../src/transport/manager.js';
import { AuthenticationError } from '../src/errors.js';

describe('manager application ingress', () => {
  it('retains the existing command shape and IDs', () => {
    const value = {
      type: 'conversation.message.send',
      commandId: randomUUID(),
      chatId: randomUUID(),
      text: 'hello',
    };
    expect(managerCommandSchema.parse(value)).toEqual(value);
  });
  it('requires mutation versions and validates upload bounds before handlers', () => {
    expect(
      managerCommandSchema.safeParse({
        type: 'chat.rename',
        commandId: randomUUID(),
        chatId: randomUUID(),
        name: 'new',
      }).success,
    ).toBe(false);
    const chunk = {
      type: 'upload.chunk',
      commandId: randomUUID(),
      uploadId: randomUUID(),
      offset: 0,
      base64: Buffer.alloc(UPLOAD_CHUNK_BYTES).toString('base64'),
    };
    expect(managerCommandSchema.safeParse(chunk).success).toBe(true);
    expect(
      managerCommandSchema.safeParse({
        ...chunk,
        base64: chunk.base64 + 'AAAA',
      }).success,
    ).toBe(false);
    expect(
      managerCommandSchema.safeParse({ ...chunk, base64: '%%%%' }).success,
    ).toBe(false);
    expect(
      managerCommandSchema.safeParse({
        type: 'upload.begin',
        commandId: randomUUID(),
        name: '../secret',
        mimeType: 'text/plain',
        size: 1,
      }).success,
    ).toBe(false);
  });
  it('authorizes every operation before calling its handler', async () => {
    const command = {
      type: 'chat.get',
      commandId: randomUUID(),
      chatId: randomUUID(),
    };
    const handler = vi.fn().mockResolvedValue({});
    const authorize = vi.fn().mockRejectedValue(new AuthenticationError());
    const transport = new ManagerTransport({ authorize }, {
      'chat.get': handler,
    } as unknown as ManagerHandlers);
    const result = await transport.dispatch(command, 'safe-correlation');
    expect(authorize).toHaveBeenCalledWith(command);
    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      commandId: command.commandId,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
  });
  it('keeps durable receipt acknowledgement independent of engine execution', async () => {
    const command = {
      type: 'conversation.message.send',
      commandId: randomUUID(),
      chatId: randomUUID(),
      text: 'wake later',
    };
    const receipt = {
      commandId: command.commandId,
      state: 'accepted',
      acceptedAt: Date.now(),
      messageId: randomUUID(),
    };
    const transport = new ManagerTransport(
      { authorize: () => Promise.resolve() },
      {
        'conversation.message.send': () =>
          Promise.resolve({ receipt, messageId: receipt.messageId }),
      } as unknown as ManagerHandlers,
    );
    expect(await transport.dispatch(command, 'correlation')).toEqual({
      type: 'command.result',
      commandId: command.commandId,
      ok: true,
      data: { receipt, messageId: receipt.messageId },
    });
  });
  it('does not expose unexpected upstream errors or malformed input', async () => {
    const transport = new ManagerTransport(
      { authorize: () => Promise.resolve() },
      {
        'chat.list': () =>
          Promise.reject(new Error('/recovery/private token=secret')),
      } as unknown as ManagerHandlers,
    );
    const failed = await transport.dispatch(
      { type: 'chat.list', commandId: randomUUID() },
      'correlation',
    );
    expect(JSON.stringify(failed)).not.toContain('/recovery');
    expect(JSON.stringify(failed)).not.toContain('token=secret');
    expect(
      await transport.dispatch({ secret: '/recovery/private' }, 'correlation'),
    ).toMatchObject({ commandId: 'invalid', ok: false });
  });
});
