import type {
  ProjectionSet,
  ProjectionGet,
  ProjectionState,
} from './projectionTypes';
import { projectRun, toolWatermarks } from './projectionHelpers';
export function projectionEvents(
  set: ProjectionSet,
  get: ProjectionGet,
): Pick<ProjectionState, 'receiveEvent'> {
  return {
    receiveEvent: (event) => {
      const state = get();
      if (event.type === 'connection.state' && state.generation === null) {
        set({
          generation: event.generation,
          sequence: event.sequence,
          connection: event.state,
        });
        return;
      }
      if (
        event.generation !== state.generation ||
        event.sequence <= state.sequence
      )
        return;
      set({ sequence: event.sequence });
      const chatId =
        event.type === 'conversation.snapshot'
          ? event.snapshot.chat.id
          : event.type === 'conversation.updated'
            ? event.chat.id
            : 'chatId' in event
              ? event.chatId
              : null;
      if (chatId && get().deletedChats[chatId]) return;
      if (chatId)
        set((current) => ({
          chatSequences: { ...current.chatSequences, [chatId]: event.sequence },
        }));
      if (
        chatId &&
        (event.type === 'conversation.snapshot' ||
          event.type === 'conversation.updated' ||
          event.type === 'conversation.deleted')
      )
        set((current) => ({
          structuralSequences: {
            ...current.structuralSequences,
            [chatId]: event.sequence,
          },
        }));
      if (event.type === 'conversation.run.text')
        set((current) => ({
          runEventSequences: {
            ...current.runEventSequences,
            [event.chatId]: event.sequence,
          },
        }));
      switch (event.type) {
        case 'connection.state':
          set({ connection: event.state });
          break;
        case 'conversation.snapshot':
          get().applySnapshot(event.snapshot);
          break;
        case 'conversation.updated':
          get().mergeChat(event.chat);
          break;
        case 'conversation.deleted': {
          get().releaseConfirmedChat(event.chatId);
          break;
        }
        case 'conversation.tool':
          set((current) => {
            const tools = [
              ...(current.tools[event.chatId] ?? []).filter(
                (tool) => tool.id !== event.tool.id,
              ),
              event.tool,
            ].slice(-100);
            return {
              tools: {
                ...current.tools,
                [event.chatId]: tools,
              },
              toolEventSequences: {
                ...current.toolEventSequences,
                [event.chatId]: toolWatermarks(tools, {
                  ...current.toolEventSequences[event.chatId],
                  [event.tool.id]: event.sequence,
                }),
              },
            };
          });
          break;
        case 'conversation.run.text': {
          const snapshot = get().snapshots[event.chatId];
          if (snapshot?.settledRun?.id === event.runId) return;
          set((current) => {
            const events = event.replace
              ? [event]
              : [...(current.runBacklog[event.chatId] ?? []), event];
            const dropped = { ...current.runDropped };
            if (event.replace) delete dropped[event.chatId];
            let bytes = events.reduce(
              (total, item) => total + item.text.length,
              0,
            );
            while (
              events.length > 1 &&
              (bytes > 262144 || events.length > 100)
            ) {
              const removed = events.shift();
              if (removed) {
                bytes -= removed.text.length;
                dropped[event.chatId] = removed;
              }
            }
            return {
              runBacklog: { ...current.runBacklog, [event.chatId]: events },
              runDropped: dropped,
            };
          });
          if (!snapshot) return;
          if (
            snapshot.activeRun?.id === event.runId &&
            snapshot.activeRun.sequence >= event.runSequence
          )
            return;
          set((current) => ({
            snapshots: {
              ...current.snapshots,
              [event.chatId]: {
                ...snapshot,
                activeRun: projectRun(snapshot.activeRun, event),
                settledRun: undefined,
              },
            },
          }));
          break;
        }
      }
    },
  };
}
