import {
  recorderMethod,
  recorderPersistence,
  followupExecution,
} from './recorder.mjs';
export const patches = [
  {
    file: 'agent-runner.runtime-BilVGTOB.mjs',
    sha256: '9dde4b1bd91a2147384ba2ea074c33e28fc7c1f7d30179b4a47250595cc33568',
    replacements: [
      [
        'execution = await (recorder?.withPendingInput ? recorder.withPendingInput(execute) : execute());',
        followupExecution,
      ],
    ],
  },
  {
    file: 'user-turn-transcript-DkAE8Np5.mjs',
    sha256: 'ac1a25cd70f525882d02a03d8b696a36964dec62f4d86315d043cf2753b8b1c9',
    prefix:
      'import { applyProcessing, processingPlan, sourceKey } from "./messenger-owner-proof.mjs";\n',
    replacements: [
      [
        'let confirmedSteerTargetRunId;',
        'let confirmedSteerTargetRunId;\n\tlet messengerProcessing, messengerProcessingWrite;\n\tlet messengerConfirmationTail = Promise.resolve();',
      ],
      [
        'const next = rewritePersistedSteerTargetRunId(applyReplacementText(candidate), confirmedSteerTargetRunId);',
        'const next = applyProcessing(rewritePersistedSteerTargetRunId(applyReplacementText(candidate), confirmedSteerTargetRunId), pendingInput ? undefined : messengerProcessing);',
      ],
      [
        'const resolveMessageForPersistence = async () => {',
        recorderPersistence +
          '\n\tconst resolveMessageForPersistence = async () => {',
      ],
      [
        'return admissionWrite.start(admissionReceipt, detached);',
        'const admitted = admissionWrite.start(admissionReceipt, detached);\n\t\tif (messengerProcessing) {\n\t\t\tconst proof = structuredClone(messengerProcessing), scope = admissionReceipt, key = sourceKey(persistedMessage);\n\t\t\tmessengerProcessingWrite = admitted.then(() => persistMessengerProcessing(proof, key, scope));\n\t\t\tmessengerProcessingWrite.catch(() => void 0);\n\t\t}\n\t\treturn messengerProcessingWrite ?? admitted;',
      ],
      [
        'await admissionWrite.pending;\n\t};',
        'await admissionWrite.pending;\n\t\tawait messengerProcessingWrite;\n\t};',
      ],
      [
        '\t\tconfirmSteerTargetRunIdForPersistence: async (targetRunId) => {',
        recorderMethod +
          '\n\t\tconfirmSteerTargetRunIdForPersistence: async (targetRunId) => {',
      ],
    ],
  },
  {
    file: 'user-turn-transcript.metadata-DfqiJdv-.mjs',
    sha256: '6fd6225662459f11f9cfeed1774975b9e4b91406ec634c2aba8d2aed54e98297',
    prefix:
      'import { restoreProcessing } from "./messenger-owner-proof.mjs";\n',
    replacements: [
      [
        'const runtimeMeta = { ...nextMessage["__openclaw"] };',
        'const runtimeMeta = { ...nextMessage["__openclaw"] };\n\trestoreProcessing(preparedMeta, runtimeMeta);',
      ],
      [
        'const originalMeta = message["__openclaw"];',
        'const originalMeta = message["__openclaw"];\n\tconst messengerProcessingOriginal = structuredClone(originalMeta?.messengerProcessing);',
      ],
      [
        'if (intent === void 0) delete protectedMeta.intent;',
        'restoreProcessing({ messengerProcessing: messengerProcessingOriginal }, protectedMeta);\n\tif (intent === void 0) delete protectedMeta.intent;',
      ],
    ],
  },
  {
    file: 'builtin-openclaw-CEs0yxf2.mjs',
    sha256: 'f2ff79ffff99ab8e58cb54cefae0628a1b44c5b3a5ff027c2a8eb95182f763c7',
    replacements: [
      [
        'await userTurnRecorder?.waitForRuntimePersistence();\n\t\t\toptions?.signal?.throwIfAborted();',
        'await userTurnRecorder?.waitForRuntimePersistence();\n\t\t\tuserTurnRecorder?.assertMessengerProcessingCommitted?.();\n\t\t\toptions?.signal?.throwIfAborted();',
      ],
    ],
  },
];
