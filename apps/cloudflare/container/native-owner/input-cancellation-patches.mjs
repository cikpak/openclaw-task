export const inputCancellationPatches = [
  {
    file: 'chat-send-handler-MxN0361b.mjs',
    sha256: '654bd764ae5a38bed1986de3eb704622b539df92ea1f60cb8744245e1f5b27b2',
    prefix:
      'import { trackInputCancellationPrelude, retireInputCancellationPrelude } from "./messenger-input-cancellation.mjs";\n',
    replacements: [
      [
        'onAdopted: async () => {\n\t\t\tadoptionStarted = true;',
        'onAdopted: async () => {\n\t\t\tretireInputCancellationPrelude(params.sessionBinding);\n\t\t\tadoptionStarted = true;',
      ],
      [
        'onDeferred: () => {\n\t\t\tif (params.hasCronCreatorAuthority)',
        'onDeferred: () => {\n\t\t\tretireInputCancellationPrelude(params.sessionBinding);\n\t\t\tif (params.hasCronCreatorAuthority)',
      ],
      [
        '\t\t\tlifecycleGeneration\n\t\t});\n\t};\n\tlet retainedRequestConflict;',
        '\t\t\tlifecycleGeneration\n\t\t});\n\t\ttrackInputCancellationPrelude(admittedRunAbort.entry, clientRunId, p.queueMode, client?.connect?.client);\n\t};\n\tlet retainedRequestConflict;',
      ],
    ],
  },
  {
    file: 'chat-abort-runtime-HvpXWrR-.mjs',
    sha256: '29cf6878f940b3c909afcbf8ce984c5f8bb3a3d8103cd33c64b1371ab18bfa5e',
    prefix:
      'import { beginInputCancellationProof } from "./messenger-input-cancellation.mjs";\n',
    replacements: [
      [
        'if (abortChatRunById(params.ops, {\n\t\t\t\trunId,\n\t\t\t\tsessionKey,\n\t\t\t\tstopReason: params.stopReason,\n\t\t\t\tonAbortCommitted: () => {\n\t\t\t\t\trecordRun(runId);\n\t\t\t\t\tdeferAbortedPartialPersistence(snapshots.find((snapshot) => snapshot.runId === runId), params.context);\n\t\t\t\t}\n\t\t\t}).aborted) recordRun(runId);',
        'const inputCancellation = beginInputCancellationProof(params.context, runId, entry);\n\t\t\tif (abortChatRunById(params.ops, {\n\t\t\t\trunId,\n\t\t\t\tsessionKey,\n\t\t\t\tstopReason: params.stopReason,\n\t\t\t\tonAbortCommitted: () => {\n\t\t\t\t\trecordRun(runId);\n\t\t\t\t\tdeferAbortedPartialPersistence(snapshots.find((snapshot) => snapshot.runId === runId), params.context);\n\t\t\t\t}\n\t\t\t}).aborted) {\n\t\t\t\trecordRun(runId);\n\t\t\t\tconst proof = inputCancellation?.();\n\t\t\t\tif (proof) (result.preExecutionInputCancellations ??= []).push(proof);\n\t\t\t}',
      ],
    ],
  },
  {
    file: 'chat-abort-handler-csuIgsSO.mjs',
    sha256: '5a3c92d2fb406d480e79dc1ac7408f6a32665bcc7d846e11f04811608a5241cd',
    replacements: [
      [
        '\t\t\trunIds: res.runIds,\n\t\t\t...res.warning ? { warning: res.warning } : {}',
        '\t\t\trunIds: res.runIds,\n\t\t\t...res.preExecutionInputCancellations?.length ? { preExecutionInputCancellations: res.preExecutionInputCancellations } : {},\n\t\t\t...res.warning ? { warning: res.warning } : {}',
      ],
    ],
  },
];
