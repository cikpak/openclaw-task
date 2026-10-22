/** R2 metadata calls lack an AbortSignal; discard any late body after cancellation. */
export function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
  late?: (value: T) => void,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let stopped = false;
    const abort = () => {
      stopped = true;
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Preservation cancelled'),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (stopped) late?.(value);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(
          error instanceof Error
            ? error
            : new Error('Recovery operation failed'),
        );
      },
    );
  });
}
