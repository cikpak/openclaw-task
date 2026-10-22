/** Test-only boundary observations. No arguments, identities, paths or secrets are retained. */
import { PrivateContainer } from '../src/engine/container.js';
import { NativeGatewayTransport } from '../src/engine/gateway/transport.js';
import type { EngineContext } from '../src/manager/types.js';
import type { AuthStorage } from '../src/engine/gateway/identity.js';
import { healthFailure, observeHealth } from './acceptance-health.ts';
type ContextOwner = { context: EngineContext };
type TransportOwner = { options: { storage: AuthStorage } };
export interface Timing {
  event: string;
  at: number;
}
async function record(storage: AuthStorage, event: string) {
  const boot = await storage.get<string>('acceptance-active-boot');
  const key = `acceptance-timing-${boot}-${event}`;
  if (!(await storage.get(key)))
    await storage.put(key, { event, at: Date.now() });
}
const start = Reflect.get(PrivateContainer.prototype, 'start');
PrivateContainer.prototype.start = async function (...args) {
  const { state } = (this as unknown as ContextOwner).context;
  await state.storage.put('acceptance-active-boot', args[0]);
  await record(state.storage, 'helper-start');
  return start.apply(this, args);
};

const health = Reflect.get(PrivateContainer.prototype, 'health');
PrivateContainer.prototype.health = async function () {
  const storage = (this as unknown as ContextOwner).context.state.storage;
  observeHealth(storage, 'attempt');
  let value;
  try {
    value = await health.call(this);
    observeHealth(storage, 'success');
  } catch (error) {
    observeHealth(storage, healthFailure(error));
    throw error;
  }
  await record(
    (this as unknown as ContextOwner).context.state.storage,
    'helper-ready',
  );
  return value;
};
const startJob = Reflect.get(PrivateContainer.prototype, 'startJob');
PrivateContainer.prototype.startJob = async function (...args) {
  const storage = (this as unknown as ContextOwner).context.state.storage;
  await storage.put(`acceptance-job-${args[0]}`, args[2]);
  if (args[2] === 'restore' || args[2] === 'start')
    await record(storage, `${args[2]}-start`);
  return startJob.apply(this, args);
};
const job = Reflect.get(PrivateContainer.prototype, 'job');
PrivateContainer.prototype.job = async function (id) {
  const value = await job.call(this, id);
  const storage = (this as unknown as ContextOwner).context.state.storage;
  const action = await storage.get<string>(`acceptance-job-${id}`);
  if (
    value.status === 'succeeded' &&
    (action === 'restore' || action === 'start')
  )
    await record(storage, `${action}-complete`);
  return value;
};
const ready = Reflect.get(NativeGatewayTransport.prototype, 'waitReady');
NativeGatewayTransport.prototype.waitReady = async function (...args) {
  await ready.apply(this, args);
  await record(
    (this as unknown as TransportOwner).options.storage,
    'sdk-authenticated',
  );
};
const request = Reflect.get(NativeGatewayTransport.prototype, 'request');
NativeGatewayTransport.prototype.request = async function (...args) {
  if (args[0] === 'chat.send')
    await record(
      (this as unknown as TransportOwner).options.storage,
      'dispatch',
    );
  return request.apply(this, args);
};
