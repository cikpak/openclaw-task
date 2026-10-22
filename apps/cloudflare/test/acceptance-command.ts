import { record } from './acceptance-receipt-shape.js';
/** Bind a private diagnostic to an actual successful synthetic send command. */
export function acceptedCommand(state: DurableObjectState, value: unknown) {
  const body = record(value);
  const uuid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
  if (
    typeof body?.chatId !== 'string' ||
    typeof body.commandId !== 'string' ||
    !uuid.test(body.chatId) ||
    !uuid.test(body.commandId)
  )
    return null;
  const read = (table: string) => {
    const row = [
      ...state.storage.sql.exec<{ json: string }>(
        `SELECT json FROM ${table} WHERE id=?`,
        body.commandId,
      ),
    ][0];
    return row ? record(JSON.parse(row.json)) : null;
  };
  const command = read('command_requests'),
    result = read('command_results');
  if (
    command?.type !== 'conversation.message.send' ||
    command.commandId !== body.commandId ||
    command.chatId !== body.chatId ||
    result?.ok !== true ||
    result.commandId !== body.commandId ||
    record(result.data)?.messageId !== body.commandId
  )
    return null;
  const mapping = [
    ...state.storage.sql.exec<{ agent_id: string; session_key: string }>(
      'SELECT agent_id,session_key FROM chats WHERE id=?',
      body.chatId,
    ),
  ][0];
  const scope = [
    ...state.storage.sql.exec<{ session_id: string }>(
      'SELECT session_id FROM submission_scopes WHERE message_id=?',
      body.commandId,
    ),
  ][0]?.session_id;
  return mapping
    ? { commandId: body.commandId, chatId: body.chatId, mapping, scope }
    : null;
}
