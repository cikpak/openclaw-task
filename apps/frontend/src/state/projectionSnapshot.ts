import type { ProjectionSet, ProjectionState } from './projectionTypes';
import { chronological, projectRun, toolWatermarks } from './projectionHelpers';
export function projectionSnapshot(
  set: ProjectionSet,
): Pick<ProjectionState, 'applySnapshot'> {
  return {
    applySnapshot: (input, replayBacklog = false, afterSequence = -1) =>
      set((state) => {
        if (state.deletedChats[input.chat.id]) return {};
        let snapshot = { ...input, messages: chronological(input.messages) };
        const history = state.olderHistory[snapshot.chat.id];
        if (history) {
          const ids = new Set(snapshot.messages.map((message) => message.id));
          const older = [
            ...history.messages,
            ...(state.snapshots[snapshot.chat.id]?.messages ?? []),
          ].filter((message) => !ids.has(message.id));
          const unique = [
            ...new Map(older.map((message) => [message.id, message])).values(),
          ];
          snapshot = {
            ...snapshot,
            messages: chronological([...unique, ...snapshot.messages]),
            historyCursor: history.cursor,
            hasOlderHistory: history.hasOlder,
          };
        }
        let sequenceGap = false;
        if (replayBacklog) {
          const afterEvents = (state.runBacklog[snapshot.chat.id] ?? []).filter(
            (event) => event.sequence > afterSequence,
          );
          const runId = snapshot.activeRun?.id ?? afterEvents.at(-1)?.runId;
          const events = afterEvents.filter(
            (event) =>
              event.runId === runId &&
              event.runSequence > (snapshot.activeRun?.sequence ?? -1),
          );
          const first = events[0];
          const dropped = state.runDropped[snapshot.chat.id];
          sequenceGap =
            !!first &&
            !first.replace &&
            !!dropped &&
            dropped.sequence > afterSequence &&
            dropped.runId === runId &&
            dropped.runSequence > (snapshot.activeRun?.sequence ?? -1);
          for (const event of events) {
            if (snapshot.settledRun?.id === event.runId) continue;
            if (
              snapshot.activeRun?.id === event.runId &&
              snapshot.activeRun.sequence >= event.runSequence
            )
              continue;
            snapshot = {
              ...snapshot,
              activeRun: projectRun(snapshot.activeRun, event),
              settledRun: undefined,
            };
          }
        }
        const backlog = { ...state.runBacklog };
        const dropped = { ...state.runDropped };
        delete dropped[snapshot.chat.id];
        delete backlog[snapshot.chat.id];
        return {
          chats: { ...state.chats, [snapshot.chat.id]: snapshot.chat },
          snapshots: { ...state.snapshots, [snapshot.chat.id]: snapshot },
          runBacklog: backlog,
          runDropped: dropped,
          resyncChats: {
            ...state.resyncChats,
            [snapshot.chat.id]: sequenceGap,
          },
          ...(snapshot.tools
            ? {
                tools: {
                  ...state.tools,
                  [snapshot.chat.id]: snapshot.tools.slice(-100),
                },
                toolEventSequences: {
                  ...state.toolEventSequences,
                  [snapshot.chat.id]: toolWatermarks(
                    snapshot.tools.slice(-100),
                    state.toolEventSequences[snapshot.chat.id] ?? {},
                  ),
                },
              }
            : {}),
        };
      }),
  };
}
