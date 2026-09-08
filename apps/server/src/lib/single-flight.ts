// Share only in-flight reads. Completed results and errors are never retained here.
export function createSingleFlight<T>(options?: { limit: () => number; full: () => Error }) {
  const pending = new Map<string, Promise<T>>();
  return (key: string, read: () => Promise<T>): Promise<T> => {
    const existing = pending.get(key);
    if (existing) return existing;
    if (options && pending.size >= options.limit()) return Promise.reject(options.full());
    const request = Promise.resolve()
      .then(read)
      .finally(() => {
        if (pending.get(key) === request) pending.delete(key);
      });
    pending.set(key, request);
    return request;
  };
}
