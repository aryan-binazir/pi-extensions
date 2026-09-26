export function abortable<T>(value: T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new Error('Operation aborted'));
    if (signal?.aborted) { abort(); void Promise.resolve(value).catch(() => {}); return; }
    signal?.addEventListener('abort', abort, {once: true});
    void Promise.resolve(value).then(
      result => { signal?.removeEventListener('abort', abort); if (signal?.aborted) abort(); else resolve(result); },
      error => { signal?.removeEventListener('abort', abort); reject(error); },
    );
  });
}
