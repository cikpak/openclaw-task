import type { Page } from '@playwright/test';
import type {
  ManagerCommand,
  ManagerResult,
  ManagerResultData,
  ManagerChunk,
  ManagerFrame,
} from '@messenger/contracts';
import { applicationPlan } from './manager-plan.js';

/** Exercise the public session -> one-use ticket -> manager socket boundary. */
export async function managerCommand(
  page: Page,
  command: ManagerCommand,
): Promise<ManagerResult> {
  return page.evaluate(async (command) => {
    const ticketReply = await fetch('/api/connection-tickets', {
      method: 'POST',
    });
    if (!ticketReply.ok)
      return {
        type: 'command.result',
        commandId: command.commandId,
        ok: false,
        error: { status: ticketReply.status, title: 'Authorization failed' },
      } as ManagerResult;
    const ticket = (await ticketReply.json()) as {
      address: string;
      ticket: string;
    };
    const address = new URL(ticket.address, location.origin);
    address.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    address.searchParams.set('ticket', ticket.ticket);
    return new Promise<ManagerResult>((resolve, reject) => {
      const socket = new WebSocket(address);
      const fragments = new Map<string, string[]>();
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('Manager command timed out'));
      }, 120_000);
      const finish = (result: ManagerResult) => {
        clearTimeout(timer);
        socket.close();
        resolve(result);
      };
      socket.onopen = () => socket.send(JSON.stringify(command));
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Manager connection failed'));
      };
      socket.onmessage = ({ data }) => {
        let frame = JSON.parse(String(data)) as ManagerFrame | ManagerChunk;
        if (frame.type === 'manager.chunk') {
          const parts =
            fragments.get(frame.id) ?? new Array<string>(frame.count);
          parts[frame.index] = frame.text;
          fragments.set(frame.id, parts);
          if (parts.filter((part) => part !== undefined).length !== frame.count)
            return;
          frame = JSON.parse(parts.join('')) as ManagerFrame;
        }
        if (
          frame.type === 'command.result' &&
          frame.commandId === command.commandId
        )
          finish(frame);
      };
    });
  }, command);
}

export function application(page: Page) {
  async function call(
    path: string,
    options: { headers?: Record<string, string>; data?: unknown } = {},
    method = 'GET',
  ) {
    const plan = applicationPlan(path, {
      method,
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.data !== undefined
        ? { body: JSON.stringify(options.data) }
        : {}),
    });
    const result = await managerCommand(page, plan.command);
    const data = result.ok ? plan.pick(result.data) : result.error;
    const status = result.ok
      ? method === 'DELETE'
        ? 202
        : 200
      : result.error.status;
    const version =
      data && typeof data === 'object' && 'version' in data
        ? data.version
        : undefined;
    return {
      status: () => status,
      ok: () => status >= 200 && status < 300,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
      headers: () => ({
        etag: typeof version === 'number' ? `"${version}"` : '',
      }),
    };
  }
  return {
    get: (path: string) => call(path),
    delete: (path: string, options?: Parameters<typeof call>[1]) =>
      call(path, options, 'DELETE'),
    patch: (path: string, options?: Parameters<typeof call>[1]) =>
      call(path, options, 'PATCH'),
  };
}

export async function managerData(
  page: Page,
  command: ManagerCommand,
): Promise<ManagerResultData> {
  const result = await managerCommand(page, command);
  if (!result.ok) throw new Error(result.error.detail ?? result.error.title);
  return result.data;
}
