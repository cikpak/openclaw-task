import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
export async function extract(source, destination, plugins, signal) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let outputDirectory;
  try {
    outputDirectory = await open(
      destination,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    await input.close();
    throw error;
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(?:PATH|HOME|OPENCLAW_(?:HOME|STATE_DIR)|XDG_(?:CACHE|CONFIG|DATA|STATE)_HOME|TMPDIR)$/.test(
        key,
      ),
    ),
  );
  try {
    return await new Promise((resolveResult, reject) => {
      const child = spawn(
        process.execPath,
        [new URL('./pdf-worker.mjs', import.meta.url).pathname],
        {
          env,
          stdio: ['pipe', 'pipe', 'ignore', input.fd, outputDirectory.fd],
          uid: 1000,
          gid: 1000,
          signal,
          killSignal: 'SIGKILL',
        },
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.length > 16_384) child.kill('SIGKILL');
      });
      child.once('error', reject);
      child.once('close', (code) => {
        try {
          if (code !== 0)
            throw new Error('PDF extraction unavailable or incomplete');
          resolveResult(JSON.parse(output));
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ plugins }));
    });
  } finally {
    await input.close();
    await outputDirectory.close();
  }
}
