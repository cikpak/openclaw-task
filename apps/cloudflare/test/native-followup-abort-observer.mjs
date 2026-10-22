import assert from 'node:assert/strict';
const status = (value) =>
  ['aborted', 'no-active-run'].includes(value) ? value : 'other';
/** Observe unchanged real RPC/production-parser results; report only bounded structural identities. */
export function observeAborts(gateway, identities, beforeBroad) {
  assert.equal(typeof gateway.abortRun, 'function');
  const request = gateway.request;
  const raw = [],
    parsed = [];
  const matches = (id) => ({
    matchesGeneratedOwner: id === identities.owner,
    matchesOriginalInput: id === identities.input,
    matchesParent: id === identities.parent,
  });
  gateway.request = async (method, params) => {
    const result = await request.call(gateway, method, params);
    if (method === 'sessions.abort') {
      assert.ok(
        raw.length < 4,
        'Single-input Stop has bounded RPC observations',
      );
      raw.push({
        kind: typeof params?.runId === 'string' ? 'exact' : 'broad',
        requestedExactOwner: params?.runId === identities.owner,
        clearQueued: params?.clearQueued === true,
        acknowledged: result?.ok === true,
        status: status(result?.status),
        warningPresent: Boolean(result?.warning),
        ownerIsString: typeof result?.abortedRunId === 'string',
        ...matches(result?.abortedRunId),
      });
    }
    return result;
  };
  const observe = async (kind, work) => {
    const result = await work();
    parsed.push({ kind, ...matches(result?.abortedRunId) });
    return result;
  };
  return {
    gateway: {
      nativeAbortProofs: gateway.nativeAbortProofs,
      history: (...args) => gateway.history(...args),
      abortRun: (mapping, runId) =>
        observe('exact', () => gateway.abortRun(mapping, runId)),
      abort: (mapping) => {
        beforeBroad();
        return observe('broad', () => gateway.abort(mapping));
      },
    },
    evidence: () => ({ raw, parsed }),
    close: () => {
      gateway.request = request;
      console.info(
        JSON.stringify({ generatedStopRpcEvidence: { raw, parsed } }),
      );
    },
  };
}
