import { expect, it } from 'vitest';
import { SafeGatewayProjection } from './safe-projection.js';
import type { ProjectionPolicy } from '../../../../backend/src/presentation/safe.js';
it('new mid-run publication resolves held path without exposing any private prefix', () => {
  const policy: ProjectionPolicy = {
    documentsRoots: ['/recovery/a/documents'],
    publications: [],
  };
  const safe = new SafeGatewayProjection(() => policy);
  const event = (
    sequence: number,
    text: string,
    state: 'delta' | 'final' = 'delta',
  ) =>
    safe.event({
      type: 'chat',
      sessionKey: 'agent:a:main',
      runId: 'r',
      sequence,
      state,
      text,
      replace: false,
    });
  expect(event(1, 'Here /recovery/a/docu')).toMatchObject({ text: 'Here ' });
  policy.publications = [
    {
      nativePath: '/recovery/a/documents/report.txt',
      classification: 'deliverable',
      file: {
        id: 'opaque123',
        name: 'report.txt',
        mimeType: 'text/plain',
        sizeBytes: 4,
        updatedAt: 1,
        category: 'deliverable',
      },
    },
  ];
  expect(event(2, 'ments/report.txt ', 'final')).toMatchObject({
    text: 'file:opaque123 ',
  });
});
