import { spawn } from 'node:child_process';
import { mkdir, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
async function nativeDocuments(workspace) {
  // Fixed relative mkdir as the native user: no root pathname ownership changes.
  const script =
    "import{mkdir}from'node:fs/promises';try{await mkdir('/proc/self/fd/3/documents',{mode:0o755})}catch(error){if(error.code!=='EEXIST')throw error}";
  await new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        uid: 1000,
        gid: 1000,
        env: {},
        stdio: ['ignore', 'ignore', 'ignore', workspace.fd],
        signal: AbortSignal.timeout(10_000),
        killSignal: 'SIGKILL',
      },
    );
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? accept()
        : reject(new Error('Native documents creation unavailable')),
    );
  });
}
/** Pin each ancestor; pre-existing document ownership/modes are never altered. */
export async function importDirectory({
  workspace,
  documentsRoot,
  session,
  create,
  retain = false,
}) {
  const handles = [];
  let leased = false;
  const close = async () => {
    for (const handle of handles.splice(0).reverse()) await handle.close();
  };
  try {
    const root = await open(workspace, flags);
    handles.push(root);
    if ((await realpath(`/proc/self/fd/${root.fd}`)) !== workspace)
      throw new Error('Workspace moved');
    let documents;
    try {
      documents = await open(`/proc/self/fd/${root.fd}/documents`, flags);
    } catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      await nativeDocuments(root);
      documents = await open(`/proc/self/fd/${root.fd}/documents`, flags);
    }
    handles.push(documents);
    if (
      (await realpath(`/proc/self/fd/${documents.fd}`)) !== documentsRoot ||
      (await realpath(`/proc/self/fd/${root.fd}`)) !== workspace
    )
      throw new Error('Documents moved');
    let parent = documents,
      expected = documentsRoot;
    for (const name of ['.messenger-inputs', session]) {
      const path = `/proc/self/fd/${parent.fd}/${name}`;
      if (create) {
        try {
          await mkdir(path, { mode: 0o755 });
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      }
      const directory = await open(path, flags);
      handles.push(directory);
      expected += `/${name}`;
      const stat = await directory.stat();
      if (
        stat.uid !== 0 ||
        stat.mode & 0o022 ||
        (await realpath(`/proc/self/fd/${directory.fd}`)) !== expected
      )
        throw new Error('Unsafe protected input directory');
      parent = directory;
    }
    if (
      (await realpath(`/proc/self/fd/${root.fd}`)) !== workspace ||
      (await realpath(`/proc/self/fd/${documents.fd}`)) !== documentsRoot
    )
      throw new Error('Import ancestor moved');
    const verify = async () => {
      if (
        (await realpath(`/proc/self/fd/${root.fd}`)) !== workspace ||
        (await realpath(`/proc/self/fd/${documents.fd}`)) !== documentsRoot ||
        (await realpath(`/proc/self/fd/${parent.fd}`)) !== expected
      )
        throw new Error('Import ancestor moved');
    };
    await verify();
    if (retain) {
      leased = true;
      return {
        path: expected,
        fdPath: `/proc/self/fd/${parent.fd}`,
        verify,
        close,
      };
    }
    return expected;
  } finally {
    if (!leased) await close();
  }
}
