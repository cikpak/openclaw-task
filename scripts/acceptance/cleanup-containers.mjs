/** Only documented idempotent/removal-in-progress Docker responses may settle. */
export function dockerFailure(error) {
  if (error?.killed || error?.signal) return 'timeout';
  if (error?.code !== 1 || typeof error.stderr !== 'string') return 'other';
  const text = error.stderr.trim();
  if (
    /^Error response from daemon: removal of container \S+ is already in progress$/u.test(
      text,
    )
  )
    return 'removal-in-progress';
  if (
    /^(?:Error response from daemon: No such container:|Error: No such object:) \S+$/u.test(
      text,
    )
  )
    return 'not-found';
  return 'other';
}

/** Exact owned deletion only. Transient attempts never replace final absence proof. */
export async function cleanupContainers(
  run,
  namespace,
  result,
  failure,
  effects,
) {
  const prefix = `workerd-openclaw-local-${namespace}-manager-ConversationManager-`;
  const { delay, now } = effects;
  const deadline = now() + 30_000;
  const observe = (step, error) => {
    const category = dockerFailure(error);
    if (result.dockerObservations.length < 64)
      result.dockerObservations.push({ step, category });
    return category;
  };
  async function list(step) {
    try {
      const { stdout } = await run('docker', [
        'ps',
        '-aq',
        '--filter',
        `name=${prefix}`,
      ]);
      return stdout.trim().split(/\s+/u).filter(Boolean);
    } catch (error) {
      observe(step, error);
      failure(step);
      return null;
    }
  }
  async function remove(ids) {
    let settling = false;
    for (const id of ids ?? []) {
      let owned = false;
      try {
        const { stdout } = await run('docker', [
          'inspect',
          '--format',
          '{{.Name}}',
          id,
        ]);
        owned = stdout.trim().startsWith(`/${prefix}`);
        if (!owned) failure('owned-name-mismatch');
      } catch (error) {
        // Miniflare may have finished removing this exact ID after inventory.
        if (observe('owned-inspect', error) === 'not-found') settling = true;
        else failure('owned-inspect');
      }
      if (!owned) continue;
      try {
        await run('docker', ['rm', '-f', id]);
        result.removedContainerIds.push(id);
        settling = true;
      } catch (error) {
        const category = observe('owned-remove', error);
        if (category === 'not-found' || category === 'removal-in-progress')
          settling = true;
        else failure('owned-remove');
      }
    }
    return settling;
  }
  let ids = await list('owned-list');
  let passes = 0;
  for (;;) {
    const settling = await remove(ids);
    ids = await list('owned-recheck');
    passes++;
    if (!ids?.length) break;
    // Keep the original independent second pass. Only known settling may extend it.
    if (passes >= 2 && (!settling || now() >= deadline)) break;
    await delay(Math.max(0, Math.min(250, deadline - now())));
  }
  const finalOwned = await list('owned-final-verification');
  result.ownedAbsent = Array.isArray(finalOwned) && finalOwned.length === 0;
  if (!result.ownedAbsent) failure('owned-still-present-or-unknown');
}
