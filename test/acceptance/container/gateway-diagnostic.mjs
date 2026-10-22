/** Fixed acceptance-only categories; never serialize native errors or identity values. */
export const identityCategories = [
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
];
export function rejectIdentity(category) {
  const error = new Error('Acceptance Gateway identity rejected');
  error.code = category;
  throw error;
}
export function crashCategory(error) {
  const writers = {
    'Detached engine writer remains': 'detached-engine-writer',
    'Recovery writer descriptor remains': 'recovery-descriptor-writer',
    'Cannot verify process ownership': 'writer-ownership-unverified',
    'Cannot verify recovery descriptor': 'writer-descriptor-unverified',
  };
  return identityCategories.includes(error?.code) ||
    Object.values(writers).includes(error?.code)
    ? error.code
    : Object.hasOwn(writers, error?.message)
      ? writers[error.message]
      : 'crash-operation-rejected';
}

export const crashPhases = [
  'capture',
  'dependencies',
  'identity',
  'signal',
  'members',
  'writers',
];
export const crashPhase = (error) =>
  crashPhases.includes(error?.phase) ? error.phase : 'unavailable';
