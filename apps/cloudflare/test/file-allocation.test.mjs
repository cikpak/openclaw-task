import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spoolFile } from '../container/files-audit.mjs';
test('spool directory/file allocation failures close source and remove any allocated directory', async () => {
  for (const failAt of ['directory', 'file']) {
    let closed = 0;
    const removed = [];
    const error = new Error('Injected capacity failure');
    const opened = {
      handle: {
        close: () => {
          closed++;
          return Promise.resolve();
        },
      },
    };
    const filesystem = {
      mkdtemp: () =>
        failAt === 'directory'
          ? Promise.reject(error)
          : Promise.resolve('/private/test-spool'),
      open: () => Promise.reject(error),
      rm: (path) => {
        removed.push(path);
        return Promise.resolve();
      },
    };
    await assert.rejects(
      () => spoolFile(opened, {}, filesystem),
      (cause) => cause === error,
    );
    assert.equal(closed, 1);
    assert.deepEqual(
      removed,
      failAt === 'directory' ? [] : ['/private/test-spool'],
    );
  }
});
