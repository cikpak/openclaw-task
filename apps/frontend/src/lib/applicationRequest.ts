import type { ManagerCommand, ManagerResultData } from '@messenger/contracts';
import { dispatchApplication } from './manager';

type Plan = { command: ManagerCommand; pick(data: ManagerResultData): unknown };
/** Resource-shaped facade; transport is exclusively the authenticated manager socket. */
export function applicationPlan(path: string, options: RequestInit = {}): Plan {
  const url = new URL(path, 'https://application.invalid');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const method = options.method ?? 'GET';
  const body =
    typeof options.body === 'string'
      ? (JSON.parse(options.body) as Record<string, unknown>)
      : {};
  const commandId = crypto.randomUUID();
  const version = Number(
    new Headers(options.headers).get('If-Match')?.replaceAll('"', ''),
  );
  const base = { commandId };
  if (parts[1] === 'chats' && parts.length === 2)
    return method === 'POST'
      ? {
          command: { ...body, type: 'chat.create' } as ManagerCommand,
          pick: (data) => data.chat,
        }
      : {
          command: { ...base, type: 'chat.list' },
          pick: (data) => ({ chats: data.chats }),
        };
  if (parts[1] === 'preferences')
    return method === 'PATCH'
      ? {
          command: {
            ...base,
            type: 'preferences.update',
            version,
            preferences: body,
          } as ManagerCommand,
          pick: (data) => data.preferences,
        }
      : {
          command: { ...base, type: 'preferences.get' },
          pick: (data) => data.preferences,
        };
  if (parts[1] === 'models')
    return {
      command: {
        ...base,
        type: 'models.list',
        chatId: url.searchParams.get('chatId') ?? undefined,
        cachedOnly: url.searchParams.get('refresh') !== 'true',
      },
      pick: (data) => ({ models: data.models }),
    };
  if (parts[1] === 'uploads' && parts[2] && method === 'DELETE')
    return {
      command: { ...base, type: 'upload.remove', uploadId: parts[2] },
      pick: () => null,
    };
  const chatId = parts[2]!;
  if (parts[1] === 'chats' && chatId) {
    if (parts.length === 3) {
      const type =
        method === 'PATCH'
          ? 'chat.rename'
          : method === 'DELETE'
            ? 'chat.delete'
            : 'chat.get';
      return {
        command: { ...base, ...body, chatId, version, type } as ManagerCommand,
        pick: (data) => data.chat ?? { status: data.status },
      };
    }
    if (parts[3] === 'recovery')
      return {
        command: { ...base, type: 'chat.recover', chatId, version },
        pick: (data) => data.chat,
      };
    if (parts[3] === 'settings')
      return {
        command: {
          ...base,
          ...body,
          type:
            parts[4] === 'recovery'
              ? 'chat.settings.resolve'
              : method === 'PATCH'
                ? 'chat.settings.update'
                : 'chat.settings.get',
          chatId,
          version,
        } as ManagerCommand,
        pick: (data) => data.settingsOperation ?? data.settings,
      };
    if (parts[3] === 'shared-files' || parts[3] === 'artifacts')
      return {
        command: {
          ...base,
          type: 'files.list',
          chatId,
          category: parts[3] === 'shared-files' ? 'shared' : 'generated',
        },
        pick: (data) =>
          parts[3] === 'shared-files'
            ? {
                files: data.files?.map((file) => ({
                  uploadId: file.id,
                  name: file.name,
                  mimeType: file.mimeType,
                  size: file.sizeBytes,
                })),
              }
            : { artifacts: data.files },
      };
  }
  throw new Error('This application operation is unavailable.');
}
export async function applicationRequest(
  path: string,
  options: RequestInit = {},
) {
  options.signal?.throwIfAborted();
  const plan = applicationPlan(path, options);
  const result = await dispatchApplication(plan.command);
  options.signal?.throwIfAborted();
  const data = plan.pick(result);
  const resource =
    data && typeof data === 'object' && 'version' in data ? data : null;
  return {
    data,
    etag:
      resource && typeof resource.version === 'number'
        ? `"${resource.version}"`
        : null,
  };
}
