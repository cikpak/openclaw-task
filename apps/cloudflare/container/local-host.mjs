import { lookup } from 'node:dns/promises';
import { appendFile, readFile } from 'node:fs/promises';

/** Native Linux Docker lacks Docker Desktop's host alias. Local emulator only. */
export async function configureLocalHost(env = process.env) {
  if (env.LOCAL_R2_EMULATOR !== '1') return;
  try {
    await lookup('host.docker.internal');
    return;
  } catch {
    /* Use this container's default bridge gateway on Linux. */
  }
  const routes = await readFile('/proc/net/route', 'utf8');
  const gatewayHex = routes
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .find(
      (fields) =>
        fields[1] === '00000000' && /^[A-Fa-f0-9]{8}$/.test(fields[2]),
    )?.[2];
  if (!gatewayHex || gatewayHex === '00000000')
    throw new Error('Local Docker host route unavailable');
  const gateway = Buffer.from(gatewayHex, 'hex').reverse().join('.');
  await appendFile('/etc/hosts', `\n${gateway} host.docker.internal\n`);
  await lookup('host.docker.internal');
}
