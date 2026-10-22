import { recentViewport } from './recentViewport';
import { commandId, request } from '../lib/api';
import { chatValid, record } from '../lib/validation';
import { useChatProjection, useNotices } from '../state/stores';
import type { Send } from './connectionCommands';
export async function refreshConnectionCatalog(
  ws: WebSocket,
  send: Send,
  current: () => boolean,
) {
  try {
    const sequences = { ...useChatProjection.getState().chatSequences };
    const requestEpoch = useChatProjection.getState().connectionEpoch;
    const { data } = await request('/api/chats');
    if (!current() || ws.readyState !== WebSocket.OPEN) return;
    if (
      !record(data) ||
      !Array.isArray(data.chats) ||
      data.chats.length > 10 ||
      !data.chats.every(chatValid)
    )
      throw new Error('Conversation catalog could not be refreshed.');
    useChatProjection
      .getState()
      .applyCatalogResult(data.chats, sequences, requestEpoch);
    // Sequential per-chat responses keep reconnect traffic bounded by one snapshot.
    for (const chat of Object.values(useChatProjection.getState().chats)) {
      if (!current() || ws.readyState !== WebSocket.OPEN) return;
      try {
        await send({
          type: 'conversation.recent.request',
          viewport: recentViewport(),
          commandId: commandId(),
          chatId: chat.id,
        });
      } catch (error) {
        if (!current()) return;
        useNotices
          .getState()
          .add(
            `${chat.name}: ${error instanceof Error ? error.message : 'Conversation refresh failed.'}`,
          );
      }
    }
  } catch (error) {
    if (current())
      useNotices
        .getState()
        .add(
          error instanceof Error
            ? error.message
            : 'Conversation refresh failed.',
        );
  }
}
