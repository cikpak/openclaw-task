const conflicts = new Map([
  ['Another operation is active', 'active-operation'],
  ['Operation conflict', 'operation-conflict'],
  ['Stale boot', 'stale-boot'],
]);
/** Retain only fixed helper error categories; never include response bodies. */
export async function helperFailure(response) {
  let category = 'other-http';
  if (response.status === 409) {
    try {
      const value = await response.json();
      category = conflicts.get(value?.error) ?? 'unknown-conflict';
    } catch {
      category = 'unknown-conflict';
    }
  }
  return Object.assign(new Error('Native fixture helper request failed'), {
    helperStatus: response.status,
    helperCategory: category,
  });
}
