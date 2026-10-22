import type {
  ProjectionSet,
  ProjectionGet,
  ProjectionState,
} from './projectionTypes';
export function projectionResults(
  set: ProjectionSet,
  get: ProjectionGet,
): Pick<ProjectionState, 'applySnapshotResult'> {
  return {
    applySnapshotResult: (
      snapshots,
      sequences,
      completeCatalog,
      requestOrder = 0,
      requestEpoch,
    ) => {
      let state = get();
      if (requestEpoch !== undefined && requestEpoch !== state.connectionEpoch)
        return;
      // Only a current-connection authoritative catalog can retire old tombstones.
      if (completeCatalog) {
        const ids = new Set(snapshots.map((snapshot) => snapshot.chat.id));
        const deletedChats = Object.fromEntries(
          Object.entries(state.deletedChats).filter(
            ([id, epoch]) => epoch >= state.connectionEpoch || ids.has(id),
          ),
        );
        set({ deletedChats });
        state = get();
      }
      if (completeCatalog) {
        const catalog = snapshots.flatMap((snapshot) => {
          if (state.deletedChats[snapshot.chat.id]) return [];
          const current = state.chats[snapshot.chat.id];
          if ((state.snapshotReadOrders[snapshot.chat.id] ?? 0) > requestOrder)
            return current ? [current] : [];
          return [
            (state.chatSequences[snapshot.chat.id] ?? -1) ===
            (sequences[snapshot.chat.id] ?? -1)
              ? snapshot.chat
              : (current ?? snapshot.chat),
          ];
        });
        for (const chat of Object.values(state.chats))
          if (
            ((state.chatSequences[chat.id] ?? -1) !==
              (sequences[chat.id] ?? -1) ||
              (state.snapshotReadOrders[chat.id] ?? 0) > requestOrder) &&
            !catalog.some((item) => item.id === chat.id)
          )
            catalog.push(chat);
        get().replaceCatalog(catalog);
      }
      for (const snapshot of snapshots) {
        if (get().deletedChats[snapshot.chat.id]) continue;
        if ((get().snapshotReadOrders[snapshot.chat.id] ?? 0) > requestOrder)
          continue;
        const changed =
          (get().chatSequences[snapshot.chat.id] ?? -1) !==
          (sequences[snapshot.chat.id] ?? -1);
        if (!changed) {
          get().applySnapshot(snapshot);
          set((current) => ({
            snapshotReadOrders: {
              ...current.snapshotReadOrders,
              [snapshot.chat.id]: requestOrder,
            },
          }));
        } else if (
          (get().structuralSequences[snapshot.chat.id] ?? -1) <=
          (sequences[snapshot.chat.id] ?? -1)
        ) {
          const state = get();
          const requestSequence = sequences[snapshot.chat.id] ?? -1;
          const newerTools = (state.tools[snapshot.chat.id] ?? []).filter(
            (tool) =>
              (state.toolEventSequences[snapshot.chat.id]?.[tool.id] ?? -1) >
              requestSequence,
          );
          const ids = new Set(newerTools.map((tool) => tool.id));
          get().applySnapshot(
            {
              ...snapshot,
              ...(snapshot.tools || newerTools.length
                ? {
                    tools: [
                      ...(snapshot.tools ?? []).filter(
                        (tool) => !ids.has(tool.id),
                      ),
                      ...newerTools,
                    ].slice(-100),
                  }
                : {}),
            },
            true,
            requestSequence,
          );
          set((current) => ({
            snapshotReadOrders: {
              ...current.snapshotReadOrders,
              [snapshot.chat.id]: requestOrder,
            },
          }));
        }
      }
    },
  };
}
