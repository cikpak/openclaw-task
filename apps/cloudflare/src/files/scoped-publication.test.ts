import { expect, it } from 'vitest';
import { Store } from '../../../backend/src/database.js';
import { normalizedTestSettings } from '../../../backend/test/fake-gateway.js';
import type { GatewayHistory } from '../../../backend/src/gateway/types.js';
import { BrowserProjection } from '../../../backend/src/presentation/safe.js';
import { ManagerAuthorization } from '../manager/authorization.js';
import type { ManagerEnv } from '../manager/types.js';
import { FileCatalog } from './catalog.js';
import { SafeGatewayProjection } from '../engine/gateway/safe-projection.js';
it('maps same-name audited links only in the exact session across streaming, canonical history and replay', async () => {
  const store = new Store(':memory:');
  try {
    const auth = new ManagerAuthorization({} as ManagerEnv, store);
    const catalog = new FileCatalog(store, auth);
    const files = [];
    for (const agentId of ['agent-a', 'agent-b']) {
      const id = crypto.randomUUID();
      const sessionKey = `agent:${agentId}:main`;
      store.reserveChat({
        id,
        name: agentId,
        status: 'idle',
        version: 1,
        createdAt: 1,
        updatedAt: 1,
        unread: false,
        settings: normalizedTestSettings,
        agentId,
        sessionKey,
        creationId: crypto.randomUUID(),
      });
      auth.claim('chat', id, 'owner');
      const documentsRoot = `/recovery/${agentId}/documents`;
      files.push({
        agentId,
        sessionKey,
        documentsRoot,
        file: await catalog.publish({
          agentId,
          sessionKey,
          documentsRoot,
          path: `${documentsRoot}/report.txt`,
          name: 'report.txt',
          mimeType: 'text/plain',
          size: 12,
          modifiedAt: 1,
          digest: 'a'.repeat(64),
        }),
      });
    }
    expect(
      catalog
        .policy()
        .publications.every((file) => file.relativePath === undefined),
    ).toBe(true);
    expect(
      new BrowserProjection(catalog.policy()).text('documents/report.txt'),
    ).not.toContain('file:');
    const raw = 'Ready [Download](documents/report.txt)';
    const history = {
      messages: [{ id: 'message', role: 'assistant', text: raw }],
      activeRun: null,
    } as GatewayHistory;
    for (const entry of files) {
      const safe = new SafeGatewayProjection((key) => catalog.policy(key));
      const expected = `Ready [Download](file:${entry.file.id})`;
      const scoped = catalog.policy(entry.sessionKey);
      expect(scoped.publications).toHaveLength(1);
      expect(scoped.publications[0]!.file.id).toBe(entry.file.id);
      expect(safe.history(history, entry.sessionKey).messages[0]!.text).toBe(
        expected,
      );
      let streamed = '';
      for (const [index, text] of [
        'Ready [Download](docu',
        'ments/report.txt)',
      ].entries()) {
        const frame = safe.event({
          type: 'chat',
          sessionKey: entry.sessionKey,
          runId: 'run',
          sequence: index + 1,
          state: index ? 'final' : 'delta',
          replace: false,
          text,
        });
        if (frame?.type === 'chat') streamed += frame.text;
      }
      expect(streamed).toBe(expected);
      expect(
        new SafeGatewayProjection((key) => catalog.policy(key)).history(
          history,
          entry.sessionKey,
        ).messages[0]!.text,
      ).toBe(expected);
      const foreign = files.find((other) => other !== entry)!;
      expect(
        safe.history(
          {
            ...history,
            messages: [
              {
                ...history.messages[0]!,
                text: foreign.documentsRoot + '/report.txt',
              },
            ],
          },
          entry.sessionKey,
        ).messages[0]!.text,
      ).not.toContain(foreign.file.id);
    }
    const first = files[0]!;
    await catalog.revoke(first, 'documents/report.txt');
    expect(
      new BrowserProjection(catalog.policy(first.sessionKey)).text(raw),
    ).not.toContain('file:');
    expect(catalog.policy('unknown-session').publications).toEqual([]);
  } finally {
    store.close();
  }
});
