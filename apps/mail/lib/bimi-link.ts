import type { AppRouter } from '@zero/server/trpc';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';

// Keep optional avatar traffic in its own batches, with at most two HTTP requests
// occupying browser connections. Mail navigation and mutations use a separate link.
export function bimiLink(url: string) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return httpBatchLink<AppRouter>({
    url,
    transformer: superjson,
    methodOverride: 'POST',
    maxItems: 20,
    fetch: async (input, options) => {
      if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
      else active++;
      const controller = new AbortController();
      const abort = () => controller.abort();
      const signal = options?.signal;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort();
      const timer = setTimeout(abort, 4000);
      try {
        const response = await fetch(input, {
          ...options,
          credentials: 'include',
          signal: controller.signal,
        });
        // Include the response body in the deadline and connection budget.
        const body = await response.arrayBuffer();
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        const next = waiting.shift();
        if (next) next();
        else active--;
      }
    },
  });
}
