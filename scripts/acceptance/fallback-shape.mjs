import assert from 'node:assert/strict';
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = [
  'stableId',
  'positiveSequence',
  'exactInputKey',
  'steerTargetPresent',
  'steerTargetMatchesParent',
  'runMatchesInput',
  'runMatchesParent',
  'newerThanLinkedUser',
  'processingShapeValid',
  'processingIncludesInput',
  'processingOwnerMatchesInput',
  'processingOwnerMatchesParent',
  'processingOwnerDiffersInputAndParent',
  'latestProcessingUser',
  'runMatchesProcessingOwner',
  'newerThanProcessingUser',
  'hasToolCall',
  'requestFailed',
  'isError',
  'hasError',
  'hasErrorMessage',
];
export function validateFallbackShape(value) {
  assert.ok(object(value), 'Structural outcome object required');
  for (const flag of [
    'nativeReadFailed',
    'historyChanged',
    'scanIncomplete',
    'paginationInvalid',
    'processingMalformed',
    'processingContradiction',
  ]) {
    assert.ok(
      value[flag] === undefined || value[flag] === false,
      'Outcome oracle must be complete and unambiguous',
    );
  }
  for (const flag of ['accepted', 'nativeReady', 'queryScoped'])
    assert.equal(
      value[flag],
      true,
      'Authoritative accepted scoped query required',
    );
  for (const flag of [
    'storedScopePresent',
    'responseSessionMatchesStoredScope',
  ])
    assert.equal(
      typeof value[flag],
      'boolean',
      'Typed optional saved-scope flags required',
    );
  assert.equal(
    value.responseSessionMatchesStoredScope,
    value.storedScopePresent,
    'A retained original scope must match the native session',
  );
  for (const flag of [
    'processingMalformed',
    'processingContradiction',
    'inFlightPresent',
    'inFlightMatchesProcessingOwner',
  ])
    assert.equal(
      value[flag],
      false,
      'No malformed, contradictory or active outcome',
    );
  assert.equal(
    value.pendingState,
    null,
    'Original accepted input must be cleared',
  );
  for (const flag of [
    'processingAssociationPresent',
    'processingOwnerDiffersInputAndParent',
  ])
    assert.equal(typeof value[flag], 'boolean');
  assert.ok(
    Number.isSafeInteger(value.processingAssociatedSequenceCount) &&
      value.processingAssociatedSequenceCount >= 0,
  );
  assert.ok(Array.isArray(value.messages) && value.messages.length > 0);
  for (const message of value.messages) {
    assert.ok(object(message) && ['user', 'assistant'].includes(message.role));
    for (const field of fields)
      assert.equal(
        typeof message[field],
        'boolean',
        'Typed structural message flags required',
      );
    assert.ok(
      [
        'stop',
        'end_turn',
        'length',
        'toolUse',
        'error',
        'aborted',
        'max_tokens',
        'other',
        'absent',
      ].includes(message.stopReason),
    );
    assert.ok(
      ['final', 'commentary', 'analysis', 'other', 'absent'].includes(
        message.channel,
      ),
    );
  }
}
export const stable = (message) => message.stableId && message.positiveSequence;
export const successful = (message) =>
  message.role === 'assistant' &&
  stable(message) &&
  message.stopReason === 'stop' &&
  ['absent', 'final'].includes(message.channel) &&
  !message.hasToolCall &&
  !message.requestFailed &&
  !message.isError &&
  !message.hasError &&
  !message.hasErrorMessage;
