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
  it('correlates invalid command bodies only with a valid bounded UUID', async () => {
    const authorize = vi.fn();
    const handler = vi.fn();
    const transport = new ManagerTransport({ authorize }, {
      'upload.begin': handler,
    } as unknown as ManagerHandlers);
    const commandId = randomUUID();
    const valid = await transport.dispatch(
      { type: 'upload.begin', commandId, secret: '/recovery/private' },
      'correlation',
    );
    expect(valid).toMatchObject({
      commandId,
      ok: false,
      error: { status: 400, code: 'INVALID_REQUEST' },
    });
    expect(JSON.stringify(valid)).not.toContain('/recovery/private');
    for (const candidate of [
      undefined,
      null,
      42,
      '/recovery/private-token',
      'a'.repeat(36),
      `${commandId}extra`,
      'secret'.repeat(10_000),
    ]) {
      const result = await transport.dispatch(
        { type: 'upload.begin', commandId: candidate },
        'correlation',
      );
      expect(result).toMatchObject({ commandId: 'invalid', ok: false });
      expect(JSON.stringify(result)).not.toContain('private-token');
      expect(JSON.stringify(result)).not.toContain('secret');
    }
    const inherited = Object.create({ commandId }) as object;
    expect(await transport.dispatch(inherited, 'correlation')).toMatchObject({
      commandId: 'invalid',
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
  it('accepts MIME syntax for policy rejection without accepting malformed MIME values', () => {
    const command = {
      type: 'upload.begin',
      commandId: randomUUID(),
      name: 'document.html',
      size: 1,
    };
    for (const mimeType of ['text/html', 'application/vnd.example+json'])
      expect(
        managerCommandSchema.safeParse({ ...command, mimeType }).success,
      ).toBe(true);
    for (const mimeType of [
      '',
      'text',
      'text/',
      '/html',
      'text/html; charset=utf-8',
      'text/ht\nml',
      'text/*',
      `text/${'a'.repeat(128)}`,
    ])
      expect(
        managerCommandSchema.safeParse({ ...command, mimeType }).success,
      ).toBe(false);
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
