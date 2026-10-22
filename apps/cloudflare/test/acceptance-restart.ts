import type { PrivateContainer } from '../src/engine/container.js';
import { safeWriterEvidence } from './acceptance-writer-evidence.ts';
/** Test-only stage evidence: no native errors, identities, paths or payloads escape. */
export async function restartGateway(
  control: Pick<PrivateContainer, 'action' | 'health'>,
): Promise<Response> {
  let stage: 'crash' | 'start' = 'crash';
  const started = Date.now();
  let reason = 'crash-operation-rejected';
  let crashPhase = 'unavailable';
  let capture:
    | { observed: number; matched: number; shapes: Record<string, boolean>[] }
    | undefined;
  let writerEvidence: ReturnType<typeof safeWriterEvidence>;
  let waited: { writerWaitMs: number } | undefined;
  try {
    const result = (await control.action('acceptance-crash')) as
      | {
          crashed?: boolean;
          category?: string;
          phase?: string;
          capture?: unknown;
          writerEvidence?: unknown;
          writerWaitMs?: number;
        }
      | undefined;
    if (result?.crashed !== true) {
      writerEvidence = safeWriterEvidence(result?.writerEvidence);
      const raw = result?.capture as typeof capture;
      if (
        raw &&
        Number.isSafeInteger(raw.observed) &&
        Number.isSafeInteger(raw.matched) &&
        Array.isArray(raw.shapes) &&
        raw.shapes.length <= 4 &&
        raw.shapes.every(
          (shape) =>
            shape &&
            ['exec', 'argv', 'uid', 'gid', 'detached'].every(
              (key) => typeof shape[key] === 'boolean',
            ),
        )
      )
        capture = {
          observed: raw.observed,
          matched: raw.matched,
          shapes: raw.shapes.map((shape) =>
            Object.fromEntries(
              ['exec', 'argv', 'uid', 'gid', 'detached'].map((key) => [
                key,
                shape[key]!,
              ]),
            ),
          ),
        };
      if (
        typeof result?.phase === 'string' &&
        [
          'capture',
          'dependencies',
          'identity',
          'signal',
          'members',
          'writers',
        ].includes(result.phase)
      )
        crashPhase = result.phase;
      const reasons = [
        'pid-mismatch',
        'group-mismatch',
        'pid-group-mismatch',
        'start-reused',
        'start-invalid',
        'zombie',
        'uid-mismatch',
        'cmdline-mismatch',
        'capture-unreadable',
        'no-captured-target',
        'ambiguous-target',
        'detached-engine-writer',
        'recovery-descriptor-writer',
        'writer-ownership-unverified',
        'writer-descriptor-unverified',
      ];
      if (
        typeof result?.category === 'string' &&
        reasons.includes(result.category)
      )
        reason = result.category;
      throw new Error('Acceptance crash guard rejected');
    }
    if (
      Number.isSafeInteger(result.writerWaitMs) &&
      result.writerWaitMs! >= 0 &&
      result.writerWaitMs! <= 30_000
    )
      waited = {
        writerWaitMs: result.writerWaitMs!,
      };
    const deadline = Date.now() + 5000;
    while ((await control.health()).gatewayState !== 'stopped') {
      if (Date.now() >= deadline)
        throw new Error('Crashed process monitor must settle');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    stage = 'start';
    await control.action('start');
    return Response.json({ ok: true, ...waited });
  } catch {
    const health = await control.health().catch(() => undefined);
    const states = [
      'starting',
      'running',
      'stopping',
      'stopped',
      'failed',
      'exited',
    ];
    return Response.json(
      {
        ok: false,
        stage,
        category: `gateway-${stage}-rejected`,
        reason,
        crashPhase,
        ...(capture ? { capture } : {}),
        ...(writerEvidence ? { writerEvidence } : {}),
        gatewayState:
          health && states.includes(health.gatewayState)
            ? health.gatewayState
            : 'unavailable',
        durationMs: Date.now() - started,
      },
      { status: 500 },
    );
  }
}
