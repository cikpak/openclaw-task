import type { ManagerCommand, ManagerResultData } from '@messenger/contracts';
export type ApplicationDispatcher = (
  command: ManagerCommand,
) => Promise<ManagerResultData>;
let dispatcher: ApplicationDispatcher | undefined;
const waiting = new Set<() => void>();
/** Non-React callers share the currently authenticated manager connection. */
export function registerApplicationDispatcher(next: ApplicationDispatcher) {
  dispatcher = next;
  for (const ready of waiting) ready();
  waiting.clear();
  return () => {
    if (dispatcher === next) dispatcher = undefined;
  };
}
export async function dispatchApplication(
  command: ManagerCommand,
): Promise<ManagerResultData> {
  const read = [
    'application.bootstrap.request',
    'chat.list',
    'chat.get',
    'chat.settings.get',
    'preferences.get',
    'models.list',
    'files.list',
    'conversation.recent.request',
    'conversation.snapshot.request',
  ].includes(command.type);
  if (!dispatcher && !read)
    throw new Error('The connection is unavailable. Please try again.');
  if (!dispatcher)
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        waiting.delete(ready);
        reject(new Error('The connection is unavailable. Please try again.'));
      }, 15000);
      waiting.add(ready);
    });
  if (!dispatcher)
    throw new Error('The connection is unavailable. Please try again.');
  return dispatcher(command);
}
