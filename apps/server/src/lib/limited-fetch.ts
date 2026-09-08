import { createCapacity } from './capacity';

// Hold the slot until the body finishes, including streamed model responses.
export function createLimitedFetch(
  limit: () => number,
  request: typeof fetch = fetch,
  timeoutMs = 60000,
  maxBytes = 1024 * 1024,
): typeof fetch {
  const capacity = createCapacity();
  return async (input, init) => {
    const release = capacity.acquire(limit());
    if (!release)
      return Response.json(
        { error: { message: 'AI_BUSY' } },
        { status: 429, headers: { 'Retry-After': '5' } },
      );
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException('AI request timed out', 'TimeoutError')),
      timeoutMs,
    );
    const signal = AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      release();
    };
    const abort = () => {
      if (finished) return;
      stream?.error(signal.reason);
      void reader?.cancel(signal.reason).catch(() => {});
      finish();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const response = await request(input, { ...init, signal });
      if (signal.aborted) {
        await response.body?.cancel();
        signal.throwIfAborted();
      }
      if (!response.body) {
        finish();
        return response;
      }
      reader = response.body.getReader();
      let bytes = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            stream = c;
          },
          async pull(c) {
            try {
              const chunk = await reader!.read();
              if (finished) return;
              if (chunk.done) {
                c.close();
                finish();
                return;
              }
              bytes += chunk.value.byteLength;
              if (bytes > maxBytes) {
                controller.abort(new Error('AI_RESPONSE_TOO_LARGE'));
                return;
              }
              c.enqueue(chunk.value);
            } catch (error) {
              if (!finished) {
                c.error(error);
                finish();
              }
            }
          },
          async cancel(reason) {
            finish();
            await reader!.cancel(reason);
          },
        }),
        { status: response.status, statusText: response.statusText, headers: response.headers },
      );
    } catch (error) {
      finish();
      throw error;
    }
  };
}
