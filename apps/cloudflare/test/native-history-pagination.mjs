import assert from 'node:assert/strict';
/** Provider-free native transcript injection stays inside the isolated test container. */
export async function verifyNativePagination(gateway, mapping) {
  const marker = `pagination-${crypto.randomUUID()}`;
  const texts = Array.from(
    { length: 5 },
    (_, index) => `${marker}-${index + 1}`,
  );
  for (const message of texts.slice(0, 4))
    await gateway.request('chat.inject', { ...mapping, message });
  const initial = await gateway.history(mapping);
  const selected = initial.messages.filter((message) =>
    texts.includes(message.text),
  );
  assert.deepEqual(
    selected.map((message) => message.text),
    texts.slice(0, 4),
  );
  const anchor = selected[2].historySequence;
  assert.ok(
    Number.isSafeInteger(anchor) && anchor > 0,
    'Native messages need authoritative sequence anchors',
  );
  const earlier = await gateway.history(mapping, {
    cursor: `before:${anchor}`,
  });
  const first = earlier.messages.filter((message) =>
    texts.includes(message.text),
  );
  assert.deepEqual(
    first.map((message) => message.text),
    texts.slice(0, 2),
  );
  assert.equal(
    new Set([...first, ...selected.slice(2)].map((message) => message.id)).size,
    4,
  );
  await gateway.request('chat.inject', { ...mapping, message: texts[4] });
  const afterAppend = await gateway.history(mapping, {
    cursor: `before:${anchor}`,
  });
  assert.deepEqual(
    afterAppend.messages
      .filter((message) => texts.includes(message.text))
      .map((message) => ({
        id: message.id,
        text: message.text,
        sequence: message.historySequence,
      })),
    first.map((message) => ({
      id: message.id,
      text: message.text,
      sequence: message.historySequence,
    })),
  );
  return {
    nativeBeforeSequencePagination: true,
    nativeAppendStableAnchor: true,
  };
}
