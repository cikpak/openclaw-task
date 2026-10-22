import assert from 'node:assert/strict';
import {
  validateFallbackShape,
  stable,
  successful,
} from './fallback-shape.mjs';
export function classifyFallbackProof(value) {
  validateFallbackShape(value);
  const users = value.messages.filter(
    (message) =>
      message.role === 'user' && stable(message) && message.exactInputKey,
  );
  let kind = 'UNSUITABLE';
  let association;
  if (value.processingAssociationPresent) {
    assert.ok(value.processingAssociatedSequenceCount > 0);
    const latest = value.messages.filter(
      (message) => message.role === 'user' && message.latestProcessingUser,
    );
    assert.equal(
      latest.length,
      1,
      'One latest explicit native source association required',
    );
    const user = latest[0];
    assert.ok(
      stable(user) && user.processingShapeValid && user.processingIncludesInput,
    );
    assert.ok(
      value.messages.some(
        (message) =>
          successful(message) &&
          message.runMatchesProcessingOwner &&
          message.newerThanProcessingUser,
      ),
      'Causal successful exact processing-owner final required',
    );
    assert.equal(
      user.processingOwnerDiffersInputAndParent,
      value.processingOwnerDiffersInputAndParent,
    );
    if (value.processingOwnerDiffersInputAndParent) {
      assert.equal(user.processingOwnerMatchesInput, false);
      assert.equal(user.processingOwnerMatchesParent, false);
      kind = 'generated-owner';
      association = 'generated-owner';
    } else {
      assert.ok(
        user.processingOwnerMatchesInput || user.processingOwnerMatchesParent,
      );
      association = 'explicit-original-owner';
    }
  } else {
    assert.equal(value.processingAssociatedSequenceCount, 0);
    assert.equal(value.processingOwnerDiffersInputAndParent, false);
    assert.equal(
      users.length,
      1,
      'One exact stable native input identity required',
    );
    const user = users[0];
    if (user.steerTargetPresent) {
      assert.equal(user.steerTargetMatchesParent, true);
      assert.ok(
        value.messages.some(
          (message) =>
            successful(message) &&
            message.runMatchesParent &&
            message.newerThanLinkedUser,
        ),
      );
      association = 'confirmed-steer';
    } else {
      assert.ok(
        value.messages.some(
          (message) =>
            successful(message) &&
            message.runMatchesInput &&
            message.newerThanLinkedUser,
        ),
      );
      association = 'direct-input';
    }
  }
  // Explicit whitelist: native identities, text and unknown future fields never escape.
  return {
    kind,
    association,
    accepted: true,
    queryScoped: true,
    pendingCleared: true,
    nativeInactive: true,
    causalSuccessfulFinal: true,
    scopeStatus: value.storedScopePresent
      ? 'verified-original'
      : 'not-retained-after-settlement',
    canonicalInputCount: users.length,
    processingSequenceCount: value.processingAssociatedSequenceCount,
  };
}
