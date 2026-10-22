import { randomUUID } from 'node:crypto';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { until } from './native-followup-fixture.mjs';
import * as output from './native-followup-output.mjs';
import { helperFailure } from './native-followup-errors.mjs';
import { helperJobs } from './native-followup-jobs.mjs';
const exec = promisify(callback);
export function containerControl(image, helperToken, gatewayToken, r2Origin) {
  const containers = new Set();
  let name, bootId, helperOrigin, gatewayOrigin;
  const docker = async (args) => {
    try {
      return (
        await exec('docker', args, {
          maxBuffer: 16 * 1024 * 1024,
          timeout: 600_000,
        })
      ).stdout.trim();
    } catch (error) {
      if (args.includes('--input-type=module'))
        await output.retainOutput(
          String(error.stdout ?? '') + String(error.stderr ?? ''),
        );
      const detail = String(error.stderr ?? '')
        .slice(-3000)
        .replace(/https?:\/\/[^\s"']+/gu, '[private-url]');
      const failure = new Error(
        `Docker probe operation failed: ${detail || error.code}`,
      );
      failure.stderr = detail;
      throw failure;
    }
  };
  const node = async (source, args = [], privileged = false) =>
    output.parseResult(
      await docker([
        'exec',
        ...(privileged ? [] : ['--user', '1000:1000']),
        name,
        'node',
        '--input-type=module',
        '-e',
        output.frameSource(source),
        ...args,
      ]),
    );
  const request = async (path, body) => {
    const response = await fetch(helperOrigin + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${helperToken}`,
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw await helperFailure(response);
    return response.json();
  };
  const { job, status: jobStatus } = helperJobs(request, () => bootId);
  const launch = async (identity, restoring = false) => {
    name = `native-followup-${randomUUID().slice(0, 12)}`;
    bootId = randomUUID();
    containers.add(name);
    const env = {
      HELPER_TOKEN: helperToken,
      GATEWAY_TOKEN: gatewayToken,
      EXPECTED_MANAGER_DEVICE_ID: identity.deviceId,
      EXPECTED_MANAGER_PUBLIC_KEY: identity.publicKey,
      BOOT_ID: bootId,
      ...(r2Origin ? { R2_ORIGIN: r2Origin, LOCAL_R2_EMULATOR: '1' } : {}),
      ...(restoring ? { RESTORE_EXPECTED: '1' } : {}),
    };
    await docker([
      'run',
      '-d',
      '--name',
      name,
      '--add-host',
      'host.docker.internal:host-gateway',
      ...Object.entries(env).flatMap(([key, value]) => [
        '--env',
        `${key}=${value}`,
      ]),
      '-p',
      '127.0.0.1::8787',
      '-p',
      '127.0.0.1::18789',
      image,
    ]);
    const port = async (internal) =>
      Number((await docker(['port', name, internal])).split(':').at(-1));
    helperOrigin = `http://127.0.0.1:${await port('8787')}`;
    gatewayOrigin = `http://127.0.0.1:${await port('18789')}`;
    await until(async () => {
      try {
        return await request('/health');
      } catch {
        return false;
      }
    }, 'helper ready');
  };
  return {
    docker,
    node,
    request,
    job,
    jobStatus,
    launch,
    name: () => name,
    origin: () => gatewayOrigin,
    close: async () => {
      const errors = [];
      for (const owned of containers) {
        await docker(['rm', '-f', owned]).catch(() => {});
        try {
          await docker(['inspect', owned]);
          errors.push(new Error('Owned native probe container still exists'));
        } catch (error) {
          if (!/No such (object|container)/iu.test(error.stderr ?? ''))
            errors.push(
              new Error('Could not verify owned native container removal'),
            );
        }
      }
      if (errors.length)
        throw new AggregateError(errors, 'Owned container cleanup failed');
    },
  };
}
