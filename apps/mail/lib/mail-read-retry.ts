const MAX_RETRIES = 3;
const MAX_SERVER_WAIT_MS = 120_000;
const transientCodes = new Set([
  'TOO_MANY_REQUESTS',
  'TIMEOUT',
  'BAD_GATEWAY',
  'SERVICE_UNAVAILABLE',
]);
const transientStatuses = new Set([408, 429, 502, 503, 504]);

type ReadError = {
  name?: string;
  cause?: { name?: string };
  data?: { code?: string; httpStatus?: number };
  meta?: { response?: { status?: number; headers?: { get(name: string): string | null } } };
};

function serverWait(error: unknown): number | undefined {
  const headers = (error as ReadError | null)?.meta?.response?.headers;
  if (typeof headers?.get !== 'function') return;
  const value = headers.get('Retry-After');
  if (!value?.trim()) return;
  const seconds = Number(value);
  const delay =
    Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

export function retryMailRead(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  const failure = error as ReadError | null;
  if (failure?.name === 'AbortError' || failure?.cause?.name === 'AbortError') return false;
  // An excessive server delay is left to explicit user retry, never shortened.
  if ((serverWait(error) ?? 0) > MAX_SERVER_WAIT_MS) return false;
  return (
    transientCodes.has(failure?.data?.code || '') ||
    transientStatuses.has(failure?.data?.httpStatus ?? failure?.meta?.response?.status ?? 0)
  );
}

export function mailReadRetryDelay(attempt: number, error: unknown): number {
  // Roughly 5s, 10s, 20s. Jitter keeps different tabs from retrying together.
  const exponential = Math.min(30_000, 5_000 * 2 ** Math.min(attempt, 10));
  const wait = Math.max(exponential, serverWait(error) ?? 0);
  // Add jitter after applying the server minimum so rate-limited tabs spread out too.
  return wait + Math.random() * exponential * 0.2;
}

// Opt in only at read-query call sites. Mutations keep their existing no-retry policy.
export const mailReadRetryOptions = {
  retry: retryMailRead,
  retryDelay: mailReadRetryDelay,
  retryOnMount: false,
} as const;
