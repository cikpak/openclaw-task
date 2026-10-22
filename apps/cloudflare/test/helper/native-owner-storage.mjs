export function simulatedStorage() {
  const records = new Map();
  const state = {
    current: true,
    failWrite: false,
    failPublish: false,
    writes: 0,
    provider: 0,
    generation: 1,
    failRewrite: false,
    pauseRewrite: undefined,
    rewriteStarted: undefined,
  };
  const anchor = (key) => ({
    entryId: key,
    sessionId: 'session',
    generation: state.generation,
    activeMessagePosition: records.size - 1,
    rawSeq: records.size,
  });
  const canonical = (message) => {
    if (!state.current || state.failWrite)
      throw new Error('Native persistence rejected');
    state.writes++;
    records.set(message.idempotencyKey, structuredClone(message));
    return {
      message: records.get(message.idempotencyKey),
      anchor: anchor(message.idempotencyKey),
      appended: true,
      messageId: message.idempotencyKey,
    };
  };
  const bindings = {
    runInDetachedAsyncContext: (work) => work(),
    waitForSessionTranscriptProjection: () => Promise.resolve(),
    resolveUserTurnTranscriptAdmission: ({ logicalTurnId, receipt }) => ({
      ...receipt,
      logicalTurnId,
    }),
    registerUserTurnTranscriptAdmissionOwner: () => {},
    publishTranscriptUpdate: () =>
      state.failPublish
        ? Promise.reject(new Error('Publication rejected'))
        : Promise.resolve(),
    rewriteTranscriptMessageAtAnchor: async (scope, update) => {
      state.rewriteStarted?.();
      await state.pauseRewrite;
      if (
        !state.current ||
        state.failWrite ||
        state.failRewrite ||
        scope.generation !== state.generation ||
        !records.has(scope.entryId)
      )
        throw new Error('Native anchor invalidated');
      const message = update(structuredClone(records.get(scope.entryId)));
      records.set(scope.entryId, structuredClone(message));
      state.writes++;
      state.generation++;
      return { message, generation: state.generation };
    },
    readActiveTranscriptEntryAnchor: (scope) =>
      state.current &&
      scope.generation === state.generation &&
      records.has(scope.entryId)
        ? anchor(scope.entryId)
        : undefined,
    stageSessionPendingInput: (_target, options) =>
      Promise.resolve({
        message: structuredClone(options.message),
        state: 'queued',
        run: (work) => work(),
      }),
    withSessionPendingInputPersistence: (_input, work) => work(),
    bindSessionPendingInputSources: () => undefined,
    persistSessionTranscriptTurn: (_target, options) => {
      const item = options.messages[0];
      const message =
        item.workerPreparation.prepareMessageAfterIdempotencyCheck(
          item.message,
        );
      return Promise.resolve({
        messages: [canonical(message)],
        sessionEntry: {},
      });
    },
    resolveSessionTranscriptRuntimeTarget: () => Promise.resolve({}),
    resolvePersistedUserTurnMessage: (params) =>
      params.message ??
      (params.input
        ? {
            role: 'user',
            content: params.input.text,
            idempotencyKey: params.input.idempotencyKey,
            __openclaw: params.input.__openclaw,
          }
        : undefined),
    isUserMessage: (message) => message?.role === 'user',
    buildLateResolvedMediaMessage: () => undefined,
  };
  return { state, records, canonical, bindings };
}
