import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
/** Exercise the production pending-input release boundary with actual native outcome evidence. */
export async function domain() {
  const app = resolve(import.meta.dirname, '..');
  const require = createRequire(resolve(app, '../backend/package.json'));
  const outfile = resolve(
    app,
    'node_modules/.cache/native-followup/reconcile.mjs',
  );
  await build({
    stdin: {
      contents:
        "export {Store} from '../backend/src/database.ts';export {reconcileInputs} from '../backend/src/chats/queue.ts';export {abortAcceptedInputs} from '../backend/src/chats/cancellations.ts';",
      resolveDir: app,
      loader: 'ts',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    plugins: [
      {
        name: 'backend-native-sqlite',
        setup(builder) {
          builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({
            path: require.resolve('better-sqlite3'),
            external: true,
          }));
        },
      },
    ],
  });
  return import(pathToFileURL(outfile).href);
}
export function outcomeStore(Store, history, inputId, scope) {
  const store = new Store(':memory:');
  store.reserveChat({
    id: 'probe',
    name: 'Probe',
    status: 'recovery',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    unread: false,
    settings: history.settings,
    agentId: 'main',
    sessionKey: 'agent:main:main',
    creationId: 'created',
  });
  store.savePending({
    id: inputId,
    chatId: 'probe',
    position: 1,
    text: 'Followup proof',
    attachments: [],
    revision: 1,
    state: 'unknown',
    submissionId: inputId,
    createdAt: 1,
  });
  store.saveSubmissionScope(inputId, scope);
  return store;
}
export async function pendingProof(history, inputId, scope) {
  const { Store, reconcileInputs } = await domain();
  const verify = (nativeScope) => {
    const store = outcomeStore(Store, history, inputId, nativeScope);
    try {
      reconcileInputs(store, 'probe', history);
      return store.pending('probe').length;
    } finally {
      store.close();
    }
  };
  assert.equal(
    verify(scope),
    0,
    'Exact successful native owner releases original accepted input',
  );
  assert.equal(
    verify(`${scope}-different`),
    1,
    'A different durable native scope cannot release work',
  );
  return { scopedPendingCleared: true, wrongScopeRetained: true };
}
