import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { retryThrottledLogin } from '../login-cooldown.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(
  new URL('../../apps/backend/package.json', import.meta.url),
);
const WebSocket = require('ws');
/** Public-origin client: only sessions/tickets/downloads use HTTP. */
export class AcceptanceClient {
  constructor(origin, username, password) {
    Object.assign(this, {
      origin,
      username,
      password,
      cookie: '',
      frames: [],
      replies: new Map(),
      chunks: new Map(),
    });
  }
  request(path, init = {}) {
    return fetch(this.origin + path, {
      ...init,
      headers: {
        origin: this.origin,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  }
  async login() {
    const response = await retryThrottledLogin(() =>
      this.request('/api/session', {
        method: 'POST',
        body: JSON.stringify({
          username: this.username,
          password: this.password,
        }),
      }),
    );
    assert.equal(response.status, 200, 'Public login must succeed');
    this.cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.match(this.cookie, /^__Host-messenger_session=/u);
    await this.connect();
    return this;
  }
  async connect() {
    const response = await this.request('/api/connection-tickets', {
      method: 'POST',
    });
    assert.equal(response.status, 200);
    const ticket = await response.json();
    this.socket = new WebSocket(
      new URL(
        `${ticket.address}?ticket=${encodeURIComponent(ticket.ticket)}`,
        this.origin,
      ).href.replace(/^http/u, 'ws'),
      { headers: { cookie: this.cookie, origin: this.origin } },
    );
    const connectedSocket = this.socket;
    this.socket.on('message', (raw) => this.frame(JSON.parse(raw.toString())));
    this.socket.on('close', () => {
      if (this.socket !== connectedSocket) return;
      for (const [commandId, reply] of this.replies)
        reply({
          ok: false,
          commandId,
          error: { code: 'CONNECTION_CLOSED', status: 503 },
        });
    });
    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
  }
  frame(frame) {
    if (frame.type === 'manager.chunk') {
      const list = this.chunks.get(frame.id) ?? [];
      list[frame.index] = frame.text;
      this.chunks.set(frame.id, list);
      if (list.filter((entry) => entry !== undefined).length === frame.count) {
        this.chunks.delete(frame.id);
        this.frame(JSON.parse(list.join('')));
      }
      return;
    }
    this.frames.push(frame);
    if (frame.type === 'command.result')
      this.replies.get(frame.commandId)?.(frame);
  }
  command(value, timeout = 180_000) {
    const commandId = value.commandId ?? randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replies.delete(commandId);
        reject(new Error(`Timed out: ${value.type}`));
      }, timeout);
      this.replies.set(commandId, (frame) => {
        clearTimeout(timer);
        this.replies.delete(commandId);
        if (frame.ok) resolve(frame.data);
        else
          reject(
            Object.assign(new Error(`${value.type}: ${frame.error.code}`), {
              code: frame.error.code,
              status: frame.error.status,
            }),
          );
      });
      this.socket.send(JSON.stringify({ ...value, commandId }));
    });
  }
  async upload(bytes, mimeType, name) {
    const { uploadId } = await this.command({
      type: 'upload.begin',
      name,
      mimeType,
      size: bytes.length,
    });
    for (let offset = 0; offset < bytes.length; offset += 48 * 1024)
      await this.command({
        type: 'upload.chunk',
        uploadId,
        offset,
        base64: bytes.subarray(offset, offset + 48 * 1024).toString('base64'),
      });
    const result = await this.command({ type: 'upload.complete', uploadId });
    return result.upload;
  }
  async create(name, settings) {
    const { chat } = await this.command({
      type: 'chat.create',
      name,
      settings,
    });
    await until(
      async () =>
        (await this.command({ type: 'chat.get', chatId: chat.id })).chat
          .status === 'idle',
      'New native agent must become idle',
    );
    return chat;
  }
  async snapshot(chatId) {
    return (
      await this.command({ type: 'conversation.snapshot.request', chatId })
    ).snapshot;
  }
  async completed(
    chatId,
    marker = 'Real Gateway integration response.',
    timeout = 180_000,
  ) {
    let snapshot;
    await until(
      async () => {
        snapshot = await this.snapshot(chatId);
        return (
          !snapshot.activeRun &&
          !snapshot.pending.length &&
          snapshot.messages.some(
            (message) =>
              message.role === 'assistant' && message.text.includes(marker),
          )
        );
      },
      'Native provider reply must complete',
      timeout,
    );
    return snapshot;
  }
  async deleteChats() {
    const { chats } = await this.command({ type: 'chat.list' });
    for (const chat of chats)
      await this.command({
        type: 'chat.delete',
        chatId: chat.id,
        version: chat.version,
      });
    await until(
      async () => !(await this.command({ type: 'chat.list' })).chats.length,
      'Owned synthetic chats must finish deletion',
    );
  }
  async close() {
    this.socket?.close();
    if (this.cookie)
      await this.request('/api/session', { method: 'DELETE' }).catch(
        () => undefined,
      );
  }
}
export async function until(predicate, message, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(250);
  }
  assert.fail(message);
}
