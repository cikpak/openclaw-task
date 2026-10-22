// Inserted only into the hash-verified pinned native recorder closure.
export const recorderMethod = `
    confirmMessengerProcessingForPersistence: (runId) => {
      const work = messengerConfirmationTail.then(async () => {
      const own = await resolveMessageForPersistence();
      const sourceRecorders = params.pendingInputSources ?? [];
      const sources = sourceRecorders.length
        ? await Promise.all(sourceRecorders.map((source) => source.resolveMessage()))
        : [own];
      const proof = processingPlan(own, sources, runId);
      if (!proof) return false;
      if (blocked) throw new Error("Processing input is blocked");
      const key = sourceKey(own);
      const previous = messengerProcessingWrite;
      if (previous) try { await previous; } catch {
        if (messengerProcessingWrite === previous) messengerProcessingWrite = void 0;
      }
      await waitForRuntimePersistence();
      await selfPersistencePromise;
      for (const source of sourceRecorders) {
        const anchor = source.getAdmissionReceipt?.();
        if (source.isBlocked?.() || anchor && !readActiveTranscriptEntryAnchor(anchor))
          throw new Error("Processing grouped source is no longer current");
      }
      messengerProcessing = proof;
      message = applyMessageOverrides(message);
      resolvedMessagePromise = void 0;
      if (admissionReceipt) {
        messengerProcessingWrite = persistMessengerProcessing(proof, key, admissionReceipt);
        messengerProcessingWrite.catch(() => void 0);
        await messengerProcessingWrite;
      }
      return true;
      });
      messengerConfirmationTail = work.catch(() => void 0);
      return work;
    },
    assertMessengerProcessingCommitted: () => {
      if (!messengerProcessing) return;
      if (blocked || !admissionReceipt || !readActiveTranscriptEntryAnchor(admissionReceipt) ||
          !isDeepStrictEqual(admittedMessage?.__openclaw?.messengerProcessing, messengerProcessing))
        throw new Error("Processing owner was not durably committed before provider execution");
      for (const source of params.pendingInputSources ?? []) {
        const anchor = source.getAdmissionReceipt?.();
        if (source.isBlocked?.() || anchor && !readActiveTranscriptEntryAnchor(anchor))
          throw new Error("Processing grouped source changed before provider execution");
      }
    },
`;

export const recorderPersistence = `
  const persistMessengerProcessing = async (proof, key, scope) => {
        const assertCurrent = () => {
          if (blocked || admissionReceipt !== scope || !isDeepStrictEqual(messengerProcessing, proof))
            throw new Error("Processing admission owner changed");
        };
        assertCurrent();
        if (sourceKey(admittedMessage) !== key)
          throw new Error("Processing admission input changed");
        const rewritten = await rewriteTranscriptMessageAtAnchor(scope, (stored) => {
          assertCurrent();
          if (!isUserMessage(stored) || sourceKey(stored) !== key)
            throw new Error("Processing canonical input changed");
          return applyProcessing(stored, proof);
        });
        assertCurrent();
        if (!rewritten) throw new Error("Processing canonical admission is no longer current");
        const admission = { ...scope, generation: rewritten.generation };
        await publishTranscriptUpdate(admission, {
          message: rewritten.message, messageId: admission.entryId,
          messageSeq: admission.activeMessagePosition + 1
        });
        refreshAdmission(admission, rewritten.message);
  };
`;

export const followupExecution = `
        const executeWithMessengerProcessing = async () => {
          turn.operation.abortSignal.throwIfAborted();
          await recorder?.confirmMessengerProcessingForPersistence?.(turn.runId);
          turn.operation.abortSignal.throwIfAborted();
          return execute();
        };
        execution = await (recorder?.withPendingInput ? recorder.withPendingInput(executeWithMessengerProcessing) : executeWithMessengerProcessing());`;
