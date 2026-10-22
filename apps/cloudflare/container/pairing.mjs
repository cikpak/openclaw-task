import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { marker } from './configuration.mjs';
import { validateIdentity, sameIdentity, scopes } from './identity.mjs';
import { command } from './device-command.mjs';
export async function pair(identity, signal) {
  validateIdentity(identity);
  const persisted = JSON.parse(await readFile(marker, 'utf8'));
  if (!sameIdentity(identity, persisted))
    throw new Error('Persisted manager mismatch');
  const allowed = (candidate) =>
    (candidate.approvedScopes ?? candidate.scopes ?? [])
      .slice()
      .sort()
      .join(',') === scopes.join(',');
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const devices = await command(['list'], signal);
    if (
      devices.paired?.some(
        (candidate) =>
          sameIdentity(candidate, identity) &&
          candidate.roles?.includes('operator') &&
          allowed(candidate),
      )
    )
      return { paired: true, deviceId: identity.deviceId };
    const pending = devices.pending?.find(
      (candidate) =>
        sameIdentity(candidate, identity) &&
        candidate.role === 'operator' &&
        (!candidate.roles ||
          candidate.roles.every((role) => role === 'operator')) &&
        allowed(candidate),
    );
    if (pending) {
      await command(['approve', pending.requestId], signal);
      continue;
    }
    await delay(500, undefined, { signal });
  }
  throw new Error('Exact manager pairing timed out');
}
