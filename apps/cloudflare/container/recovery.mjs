import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runtime } from './environment.mjs';
import { validId } from './jobs.mjs';
import { objects } from './objects.mjs';
import { checkpoint } from './checkpoint-process.mjs';
import { upload, download } from './transfers.mjs';
const stageRoot = join(runtime, 'staging');
export function createRecovery() {
  return {
    async capture({ checkpointId }, signal) {
      if (!validId(checkpointId)) throw new Error('Invalid checkpoint ID');
      await mkdir(stageRoot, { recursive: true, mode: 0o700 });
      const stage = join(stageRoot, checkpointId);
      try {
        const descriptor = JSON.parse(
          await readFile(join(stage, 'descriptor.json'), 'utf8'),
        );
        objects(descriptor);
        return descriptor;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try {
        const descriptor = await checkpoint(
          'capture',
          stage,
          checkpointId,
          signal,
        );
        objects(descriptor);
        return descriptor;
      } catch (error) {
        await rm(stage, { recursive: true, force: true });
        throw error;
      }
    },
    async upload({ checkpointId, grants, reuse }, signal) {
      if (!validId(checkpointId)) throw new Error('Invalid checkpoint ID');
      const stage = join(stageRoot, checkpointId),
        descriptor = JSON.parse(
          await readFile(join(stage, 'descriptor.json'), 'utf8'),
        );
      return upload(stage, descriptor, grants, reuse, signal);
    },
    async restore({ descriptor, grants }, signal) {
      objects(descriptor);
      await mkdir(stageRoot, { recursive: true, mode: 0o700 });
      const stage = join(stageRoot, `restore-${descriptor.checkpointId}`);
      await rm(stage, { recursive: true, force: true });
      await mkdir(stage, { mode: 0o700 });
      try {
        await download(stage, descriptor, grants, signal);
        return await checkpoint('restore', stage, descriptor, signal);
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    },
    cleanup: () => rm(stageRoot, { recursive: true, force: true }),
    inspect: (signal) => checkpoint('inspect', stageRoot, '', signal),
  };
}
