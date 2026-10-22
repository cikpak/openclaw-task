import type { RecoveryDescriptor } from './types.js';

/** Recurring content may reuse only a currently committed object incarnation. */
export function assertFileIncarnations(
  descriptor: RecoveryDescriptor,
  previous?: RecoveryDescriptor,
): void {
  if (!/^[A-Za-z0-9_-]+$/.test(descriptor.checkpointId))
    throw new Error('Invalid recovery generation');
  const seen = new Map<string, { sha256: string; size: number }>();
  for (const file of descriptor.files) {
    if (!/^[a-f0-9]{64}$/.test(file.sha256))
      throw new Error('Invalid recovery file checksum');
    const fresh =
      file.key === `files/${descriptor.checkpointId}/${file.sha256}`;
    const reused = previous?.files.some(
      (before) =>
        before.key === file.key &&
        before.sha256 === file.sha256 &&
        before.size === file.size,
    );
    const existing = seen.get(file.key);
    if (
      (!fresh && !reused) ||
      (existing &&
        (existing.sha256 !== file.sha256 || existing.size !== file.size))
    )
      throw new Error('Recovery file key incarnation is not coherent');
    seen.set(file.key, file);
  }
}
