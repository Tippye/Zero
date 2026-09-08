// No in-memory waiting queue: excess work is left with the caller for a later retry.
export function createCapacity() {
  let active = 0;
  return {
    get active() {
      return active;
    },
    acquire(limit: number): (() => void) | undefined {
      if (active >= limit) return;
      active++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          active--;
        }
      };
    },
  };
}

export function concurrencyLimit(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 32)
    throw new Error('Invalid concurrency limit (expected 1–32)');
  return limit;
}
