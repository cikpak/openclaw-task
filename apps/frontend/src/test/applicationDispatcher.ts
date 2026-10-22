import type { ManagerCommand, ManagerResultData } from '@messenger/contracts';
import { ApiError } from '../lib/api';

/** Legacy response fixtures remain useful; only this test adapter translates them. */
export async function fixtureApplication(
  command: ManagerCommand,
): Promise<ManagerResultData> {
  let path = '';
  let method = 'GET';
  let body: unknown;
  const headers: Record<string, string> = {};
  if ('version' in command && Number.isFinite(command.version))
    headers['If-Match'] = `"${command.version}"`;
  // Unsupported commands deliberately fail rather than hiding missing fixtures.
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (command.type) {
    case 'chat.list':
      path = '/api/chats';
      break;
    case 'chat.get':
      path = `/api/chats/${command.chatId}`;
      break;
    case 'chat.create': {
      path = '/api/chats';
      method = 'POST';
      const payload: Record<string, unknown> = { ...command };
      delete payload.type;
      body = payload;
      break;
    }
    case 'chat.rename':
      path = `/api/chats/${command.chatId}`;
      method = 'PATCH';
      body = { name: command.name };
      break;
    case 'chat.delete':
      path = `/api/chats/${command.chatId}`;
      method = 'DELETE';
      break;
    case 'chat.recover':
      path = `/api/chats/${command.chatId}/recovery`;
      method = 'POST';
      break;
    case 'chat.settings.get':
      path = `/api/chats/${command.chatId}/settings`;
      break;
    case 'chat.settings.update':
      path = `/api/chats/${command.chatId}/settings`;
      method = 'PATCH';
      body = { settings: command.settings, policy: command.policy };
      break;
    case 'chat.settings.resolve':
      path = `/api/chats/${command.chatId}/settings/recovery`;
      method = 'POST';
      body = { action: command.action };
      break;
    case 'preferences.get':
      path = '/api/preferences';
      break;
    case 'preferences.update':
      path = '/api/preferences';
      method = 'PATCH';
      body = command.preferences;
      break;
    case 'models.list':
      path = `/api/models${command.chatId ? `?chatId=${encodeURIComponent(command.chatId)}` : ''}`;
      break;
    case 'files.list':
      path = `/api/chats/${command.chatId}/${command.category === 'shared' ? 'shared-files' : 'artifacts'}`;
      break;
    case 'upload.remove':
      path = `/api/uploads/${command.uploadId}`;
      method = 'DELETE';
      break;
    default:
      throw new Error(`No legacy fixture for ${command.type}`);
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...(method === 'GET' ? {} : { method }),
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data =
    response.status === 204
      ? null
      : ((await response.json()) as Record<string, unknown>);
  if (!response.ok)
    throw new ApiError(
      typeof data?.detail === 'string'
        ? data.detail
        : 'The request could not be completed. Please try again.',
      response.status,
      typeof data?.code === 'string' ? data.code : 'REQUEST_FAILED',
    );
  switch (command.type) {
    case 'chat.list':
      return { chats: data?.chats as ManagerResultData['chats'] };
    case 'chat.delete':
      return { status: data?.status as ManagerResultData['status'] };
    case 'chat.create':
    case 'chat.get':
    case 'chat.rename':
    case 'chat.recover':
      return { chat: data as unknown as ManagerResultData['chat'] };
    case 'chat.settings.get':
      return { settings: data as unknown as ManagerResultData['settings'] };
    case 'chat.settings.update':
    case 'chat.settings.resolve':
      return {
        settingsOperation:
          data as unknown as ManagerResultData['settingsOperation'],
      };
    case 'preferences.get':
    case 'preferences.update':
      return {
        preferences: data as unknown as ManagerResultData['preferences'],
      };
    case 'models.list':
      return { models: data?.models as ManagerResultData['models'] };
    case 'files.list':
      return {
        files: (command.category === 'shared'
          ? (data?.files as Record<string, unknown>[] | undefined)?.map(
              (file) => ({
                id: file.uploadId,
                name: file.name,
                mimeType: file.mimeType,
                sizeBytes: file.size,
                category: 'input',
              }),
            )
          : data?.artifacts) as ManagerResultData['files'],
      };
    case 'upload.remove':
      return {};
    default:
      return {};
  }
}
