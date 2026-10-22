import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runInNewContext } from 'node:vm';
import { patches } from '../../container/native-owner/patches.mjs';
import { transform } from '../../container/native-owner/install.mjs';
import * as proof from '../../container/native-owner/proof.mjs';
import { simulatedStorage } from './native-owner-storage.mjs';
const upstream =
  'ghcr.io/openclaw/openclaw:2026.10.1@sha256:9001e8a880d6ca028b590932b83b9335a26225e86c2a8a7aa9af7c59d6842953';
export function upstreamSources() {
  const script = `import{readFileSync}from'node:fs';console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(patches.map((patch) => patch.file))}.map(file=>[file,readFileSync('/app/dist/'+file,'utf8')]))));`;
  const sources = JSON.parse(
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--entrypoint',
        'node',
        process.env.OPENCLAW_UPSTREAM_IMAGE ?? upstream,
        '--input-type=module',
        '-e',
        script,
      ],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    ),
  );
  return sources;
}
export const nativeSources = () =>
  Object.fromEntries(
    Object.entries(upstreamSources()).map(([file, source]) => [
      file,
      transform(
        source,
        patches.find((patch) => patch.file === file),
      ),
    ]),
  );
const strip = (source) =>
  source.replace(/^import .*;\n/gm, '').replace(/^export .*;\n?/gm, '');
export function fixture(sources) {
  const { state, records, canonical, bindings } = simulatedStorage();
  const globals = {
    ...proof,
    process: { env: {} },
    structuredClone,
    Buffer,
    Error,
    AggregateError,
    Map,
    Set,
    WeakMap,
    Promise,
    Date,
    randomUUID,
    isDeepStrictEqual,
    normalizeOptionalString: (value) =>
      typeof value === 'string' ? value.trim() || undefined : undefined,
    asOptionalRecord: (value) =>
      value && typeof value === 'object' ? value : undefined,
    normalizeInputProvenance: (value) => value,
    truncateUtf16Safe: (value, size) => value.slice(0, size),
    Check: () => false,
  };
  const metadata = runInNewContext(
    strip(sources['user-turn-transcript.metadata-DfqiJdv-.mjs']) +
      '\n({normalizePersistedSteerTargetRunId,rewritePersistedSteerTargetRunId,buildRunUserTurnIdempotencyKey,preparePersistedUserTurnMessageForTranscriptWrite,restorePreparedUserTurnOperationalMetaForRuntime})',
    globals,
  );
  Object.assign(globals, metadata, bindings);
  const create = runInNewContext(
    strip(sources['user-turn-transcript-DkAE8Np5.mjs']) +
      '\ncreateUserTurnTranscriptRecorder',
    globals,
  );
  const recorder = (message, rest = {}) =>
    create({
      message,
      target: { sessionId: 'session', sessionKey: 'agent:agent:main' },
      onPersistenceError() {},
      ...rest,
    });
  const builtin = sources['builtin-openclaw-CEs0yxf2.mjs'];
  const begin = builtin.indexOf('const persistThenStream = async (');
  const end = builtin.indexOf('\n\t\tconst providerPromptStreamFn', begin);
  if (begin < 0 || end < 0)
    throw new Error('Pinned provider fixture boundary changed');
  const provider = (userTurnRecorder) =>
    runInNewContext(builtin.slice(begin, end) + '\npersistThenStream', {
      userTurnRecorder,
      assertSteeringCurrent() {},
      input: {
        persistToolResultProjections: () => Promise.resolve(),
        assertHostActive: () => {
          if (!state.current) throw new Error('Host invalidated');
        },
      },
      captureCurrentPromptForModel: false,
      activeSession: { isCompacting: false },
      baseStreamFn: () => {
        state.provider++;
        return Promise.resolve('stream');
      },
    })({}, {}, { signal: new AbortController().signal });
  const followup = (record, execute, controller = new AbortController()) => {
    const runtime = sources['agent-runner.runtime-BilVGTOB.mjs'];
    const start = runtime.indexOf(
      'const executeWithMessengerProcessing = async () => {',
    );
    const finish = runtime.indexOf('\n\t} catch (error)', start);
    return runInNewContext(
      '(async () => { let execution;\n' +
        runtime.slice(start, finish) +
        '\nreturn execution; })()',
      {
        turn: {
          runId: 'generated-followup',
          operation: { abortSignal: controller.signal },
        },
        recorder: record,
        execute,
      },
    );
  };
  return { state, records, recorder, canonical, provider, metadata, followup };
}
export const input = (key = 'client-input:user', extra = {}) => ({
  role: 'user',
  idempotencyKey: key,
  content: 'Exact native source',
  __openclaw: {
    transport: {
      clients: [
        { id: 'gateway-client', mode: 'cli', displayName: 'Messenger manager' },
      ],
    },
    ...extra,
  },
});
