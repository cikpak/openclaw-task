import type {
  BrowserFile,
  ManagerCommand,
  ManagerResultData,
} from '@messenger/contracts';
import {
  ApplicationError,
  GatewayUnavailableError,
  NotFoundError,
} from '../../../backend/src/errors.js';
import { sessionToken } from '../auth/http.js';
import type { EngineContext, Grant } from '../manager/types.js';
import type { ManagerAuthorization } from '../manager/authorization.js';
import type { GatewayMapping } from '../../../backend/src/gateway/types.js';
import { FileCatalog } from './catalog.js';
import { FileReaders } from './readers.js';
import { UploadService } from './uploads/service.js';
import type { RecoveryDescriptor } from '../engine/recovery/types.js';
import { InputPublications } from './input-audit.js';

interface LiveFiles {
  usable(): boolean;
  read(mapping: GatewayMapping, path: string): Promise<Response>;
  readInput(mapping: GatewayMapping, id: string): Promise<Response>;
}
export class ManagerFiles {
  readonly catalog: FileCatalog;
  readonly readers: FileReaders;
  readonly uploads: UploadService;
  readonly inputs: InputPublications;
  liveFiles: LiveFiles | undefined;
  constructor(
    readonly context: EngineContext,
    readonly auth: ManagerAuthorization,
  ) {
    this.catalog = new FileCatalog(context.store, auth);
    this.readers = new FileReaders(context.store, () =>
      context.state.waitUntil(
        context.schedule.set('file-readers', Date.now() + 1000),
      ),
    );
    this.uploads = new UploadService(
      context,
      auth,
      (row) => !this.readers.keys().has(row.key),
    );
    context.store.db.exec(
      'CREATE TABLE IF NOT EXISTS input_file_paths (id TEXT PRIMARY KEY,path TEXT NOT NULL,object_key TEXT)',
    );
    this.inputs = new InputPublications(context.store, this.uploads);
  }
  private inputFile(
    id: string,
    accountId: string,
    chatId?: string,
  ): BrowserFile | null {
    const row = this.uploads.lookup(id);
    if (
      !row ||
      row.status !== 'complete' ||
      row.accountId !== accountId ||
      !row.chatId ||
      (chatId && row.chatId !== chatId)
    )
      return null;
    const publication = this.inputs.get(id);
    if (publication?.eligible === false) return null;
    this.auth.require('chat', row.chatId, accountId);
    return {
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      sizeBytes: publication?.size ?? row.size,
      category: 'input',
      updatedAt: publication?.modifiedAt ?? row.expiresAt - 3_600_000,
    };
  }
  private file(id: string, accountId: string, chatId?: string): BrowserFile {
    const input = this.inputFile(id, accountId, chatId);
    if (input) return input;
    const row = this.catalog.get(id);
    if (row.accountId !== accountId || (chatId && row.chatId !== chatId))
      throw new NotFoundError();
    this.auth.require('chat', row.chatId, accountId);
    return row.file;
  }
  async command(
    command: ManagerCommand,
    grant: Grant,
  ): Promise<ManagerResultData | undefined> {
    const upload = await this.uploads.handle(command, grant.accountId);
    if (upload) return upload;
    if (command.type === 'files.list') {
      const inputs = (
        this.context.store.db
          .prepare('SELECT id FROM staged_uploads WHERE chat_id = ?')
          .all(command.chatId) as { id: string }[]
      ).flatMap(({ id }) => {
        const file = this.inputFile(id, grant.accountId, command.chatId);
        return file ? [file] : [];
      });
      return {
        files:
          command.category === 'shared'
            ? inputs
            : command.category === 'generated'
              ? this.catalog.list(command.chatId, grant.accountId)
              : [
                  ...inputs,
                  ...this.catalog.list(command.chatId, grant.accountId),
                ],
      };
    }
    if (command.type !== 'files.resolve') return undefined;
    const file = this.file(command.fileId, grant.accountId, command.chatId);
    const response = await this.context.env.BACKEND.fetch(
      'https://backend/internal/downloads/issue',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grantId: grant.id,
          managerId: this.auth.managerId,
          fileId: file.id,
        }),
      },
    );
    if (!response.ok)
      throw new ApplicationError(
        401,
        'AUTHENTICATION_REQUIRED',
        'Your session is no longer available.',
      );
    const permission = await response.json<{
      ticket: string;
      expiresAt: number;
    }>();
    if (!/^[a-f0-9]{64}$/.test(permission.ticket))
      throw new GatewayUnavailableError();
    return {
      file,
      download: {
        url: `/downloads/${permission.ticket}`,
        expiresAt: permission.expiresAt,
      },
    };
  }
  recordInputPath(id: string, path: string): void {
    this.context.store.db
      .prepare(
        'INSERT INTO input_file_paths VALUES (?, ?, NULL) ON CONFLICT(id) DO UPDATE SET path = excluded.path',
      )
      .run(id, path);
  }
  commit(descriptor: RecoveryDescriptor): void {
    this.catalog.commit(descriptor);
    this.inputs.commit(descriptor);
  }

  async download(request: Request): Promise<Response> {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    if (
      (request.headers.has('Origin') &&
        request.headers.get('Origin') !== this.context.env.APP_ORIGIN) ||
      request.headers.get('Sec-Fetch-Site') === 'cross-site'
    )
      return new Response(null, { status: 403 });
    const ticket = new URL(request.url).pathname.split('/')[2] ?? '';
    const token = sessionToken(request);
    if (!token) return new Response(null, { status: 401 });
    const result = await this.context.env.BACKEND.fetch(
      'https://backend/internal/downloads/consume',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ticket,
          sessionToken: token,
          managerId: this.auth.managerId,
        }),
      },
    );
    if (!result.ok) return new Response(null, { status: 401 });
    const { grant, fileId } = await result.json<{
      grant: Grant;
      fileId: string;
    }>();
    const file = this.file(fileId, grant.accountId);
    this.auth.require('file', fileId, grant.accountId);
    const upload = this.uploads.lookup(fileId);
    const native = upload ? undefined : this.catalog.get(fileId);
    const chat = this.context.store.getChat(native?.chatId ?? upload!.chatId!);
    // An accepted input not yet handed to the engine has an authoritative staging source.
    let local = this.liveFiles?.usable() === true;
    const path = this.context.store.db
      .prepare('SELECT path,object_key FROM input_file_paths WHERE id = ?')
      .get(fileId) as { path: string; object_key: string | null } | undefined;
    if (upload && !path) local = false;
    const key = local
      ? null
      : (native?.objectKey ?? (path ? path.object_key : upload?.key) ?? null);
    if (!local && !key) throw new GatewayUnavailableError();
    const reader = this.readers.admit(local, key);
    try {
      let body: ReadableStream<Uint8Array> | null;
      let size = file.sizeBytes;
      if (local) {
        if (!chat.agentId || !chat.sessionKey)
          throw new GatewayUnavailableError();
        const mapping = { agentId: chat.agentId, sessionKey: chat.sessionKey };
        const response = upload
          ? await this.liveFiles!.readInput(mapping, fileId)
          : await this.liveFiles!.read(mapping, native!.path);
        if (!response.ok) {
          await response.body?.cancel();
          throw new GatewayUnavailableError();
        }
        body = response.body;
        size = Number(response.headers.get('content-length') ?? size);
      } else {
        const object = await this.context.env.RECOVERY_BUCKET?.get(key!);
        if (!object) throw new NotFoundError();
        body = object.body;
        size = object.size;
      }
      if (!body) throw new GatewayUnavailableError();
      return new Response(this.readers.stream(body, reader), {
        headers: {
          'content-type': file.mimeType,
          'content-length': String(size),
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-security-policy': "sandbox; default-src 'none'",
        },
      });
    } catch (error) {
      this.readers.release(reader);
      throw error;
    }
  }
}
