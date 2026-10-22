// Historical Node adapter regression fixture; never loaded by Cloudflare.
// Acceptance-only instrumentation. Never log RPC parameters, payloads or messages.
import { readFileSync } from 'node:fs';
const safeNames = new Set([
  'Error',
  'ZodError',
  'GatewayUnavailableError',
  'ConflictError',
  'ValidationError',
  'GatewayRequestError',
  'GatewayClientRequestError',
  'GatewayClientRequestTimeoutError',
]);
const safeDetails = new Set([
  'AUTH_REQUIRED',
  'AUTH_UNAUTHORIZED',
  'AUTH_TOKEN_MISSING',
  'AUTH_TOKEN_MISMATCH',
  'AUTH_DEVICE_TOKEN_MISMATCH',
  'AUTH_SCOPE_MISMATCH',
  'AUTH_RATE_LIMITED',
  'AUTHENTICATED_PROFILE_UNAVAILABLE',
  'OPERATOR_ACCESS_DENIED',
  'PROTOCOL_MISMATCH',
  'DEVICE_IDENTITY_REQUIRED',
  'DEVICE_AUTH_INVALID',
  'DEVICE_AUTH_DEVICE_ID_MISMATCH',
  'DEVICE_AUTH_SIGNATURE_EXPIRED',
  'DEVICE_AUTH_NONCE_REQUIRED',
  'DEVICE_AUTH_NONCE_MISMATCH',
  'DEVICE_AUTH_SIGNATURE_INVALID',
  'DEVICE_AUTH_PUBLIC_KEY_INVALID',
  'PAIRING_REQUIRED',
  'CLIENT_VERSION_MISMATCH',
]);
const safeCodes = new Set([
  'GATEWAY_UNAVAILABLE',
  'AGENT_INSTRUCTIONS_CONFLICT',
  'VALIDATION_ERROR',
  'INVALID_REQUEST',
  'NOT_FOUND',
  'UNAVAILABLE',
  'UNAUTHORIZED',
]);
export function recoveryError(error) {
  return {
    name: safeNames.has(error?.name) ? error.name : 'other',
    code: safeCodes.has(error?.code)
      ? error.code
      : safeCodes.has(error?.gatewayCode)
        ? error.gatewayCode
        : 'other',
    issues: Array.isArray(error?.issues) ? error.issues.length : 0,
    detail: safeDetails.has(error?.details?.code)
      ? error.details.code
      : 'other',
  };
}
export function connectionCategory(error) {
  const message = String(error?.message ?? '').toLowerCase();
  for (const [category, pattern] of [
    ['fingerprint', /fingerprint/u],
    ['certificate', /certificate|\btls\b/u],
    ['refused', /econnrefused/u],
    ['reset', /econnreset/u],
    ['pairing', /pairing/u],
    ['authentication', /auth|token/u],
    ['timeout', /timeout|timed out/u],
    ['dns', /enotfound|eai_again/u],
  ])
    if (pattern.test(message)) return category;
  return 'other';
}
export function attachRecoveryDiagnostics({ gateway, chats, store }, emit) {
  let rows = 0;
  const pending = new Map();
  const log = (record) => {
    try {
      if (rows++ < 4096)
        emit(
          JSON.stringify({
            recoveryDiagnostic: true,
            at: Date.now(),
            ...record,
          }),
        );
    } catch {
      /* An observer must never replace an application result or error. */
    }
  };
  for (const method of [
    'history',
    'subscribe',
    'lookupCreation',
    'recoverCreation',
    'remove',
  ]) {
    if (typeof gateway[method] !== 'function') continue;
    const original = gateway[method].bind(gateway);
    gateway[method] = async (...args) => {
      const started = Date.now();
      const key = Symbol(method);
      pending.set(key, { method, started });
      try {
        return await original(...args);
      } catch (error) {
        log({
          phase: method,
          durationMs: Date.now() - started,
          ...recoveryError(error),
        });
        throw error;
      } finally {
        pending.delete(key);
      }
    };
  }
  const reconcile = chats.reconcileAll.bind(chats);
  chats.reconcileAll = async (...args) => {
    const started = Date.now();
    try {
      return await reconcile(...args);
    } catch (error) {
      log({ phase: 'reconcile-error', ...recoveryError(error) });
      throw error;
    } finally {
      log({
        phase: 'reconcile',
        durationMs: Date.now() - started,
        gatewayReady: gateway.ready,
        reconciled: chats.reconciled,
      });
    }
  };
  let previous = '';
  const instrumented = new WeakSet();
  const timer = setInterval(() => {
    const client = gateway.client;
    if (client?.opts && !instrumented.has(client)) {
      instrumented.add(client);
      for (const callback of [
        'onConnectError',
        'onClose',
        'onHelloOk',
        'onReconnectPaused',
      ]) {
        const original = client.opts[callback];
        client.opts[callback] = (...args) => {
          log({
            phase: callback,
            ...(callback === 'onConnectError'
              ? {
                  category: connectionCategory(args[0]),
                  ...recoveryError(args[0]),
                }
              : {}),
            ...(callback === 'onClose'
              ? { closeCode: typeof args[0] === 'number' ? args[0] : 0 }
              : {}),
            ...(callback === 'onReconnectPaused'
              ? {
                  detail: safeDetails.has(args[0]?.detailCode)
                    ? args[0].detailCode
                    : 'other',
                }
              : {}),
          });
          return original?.(...args);
        };
      }
    }
    const state = {
      gatewayReady: gateway.ready,
      reconciled: chats.reconciled,
      chats: store.listChats().length,
      tombstones: store.tombstones().length,
      pending: [...pending.values()].map(({ method, started }) => ({
        method,
        ageSeconds: Math.floor((Date.now() - started) / 1000),
      })),
    };
    if (client?.opts && gateway.config?.gatewayTlsFingerprintFile) {
      try {
        const normalize = (value) =>
          String(value)
            .trim()
            .replace(/^sha256\$/iu, '')
            .replaceAll(':', '')
            .toLowerCase();
        state.pinMatchesPublished =
          normalize(client.opts.tlsFingerprint) ===
          normalize(
            readFileSync(gateway.config.gatewayTlsFingerprintFile, 'utf8'),
          );
      } catch {
        state.pinMatchesPublished = null;
      }
    }
    const serialized = JSON.stringify(state);
    if (serialized !== previous) {
      previous = serialized;
      log({ phase: 'state', ...state });
    }
  }, 1000);
  timer.unref();
  return () => clearInterval(timer);
}
