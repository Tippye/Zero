import { TRPCError } from '@trpc/server';

const loopbackNames = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalLlmHost(hostname: string) {
  if (loopbackNames.has(hostname) || hostname === 'host.docker.internal') return true;
  const parts = hostname.split('.').map(Number);
  if (
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname) &&
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    return (
      parts[0] === 10 ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 192 && parts[1] === 168)
    );
  }
  return /^\[f[cd][0-9a-f]{2}:/i.test(hostname);
}

// Docker deployments explicitly map local LLM URLs to their host. Stored URLs and
// credential ownership checks retain the address originally entered by the user.
export function llmRequestUrl(value: string | URL | Request, loopbackHost?: string) {
  const url = new URL(
    typeof value === 'string' ? value : value instanceof URL ? value.href : value.url,
  );
  if (loopbackHost && url.protocol === 'http:' && loopbackNames.has(url.hostname)) {
    if (!/^[a-zA-Z0-9.-]+$/.test(loopbackHost)) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'LLM_INVALID_HOST_MAPPING' });
    }
    url.hostname = loopbackHost;
  }
  return url.href;
}

export async function readLlmJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new TRPCError({ code: 'BAD_GATEWAY', message: 'LLM_INVALID_RESPONSE' });
  let bytes = 0,
    text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 1024 * 1024) {
        await reader.cancel();
        throw new TRPCError({ code: 'BAD_GATEWAY', message: 'LLM_INVALID_RESPONSE' });
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw error;
    throw new TRPCError({ code: 'BAD_GATEWAY', message: 'LLM_INVALID_RESPONSE' });
  } finally {
    reader.releaseLock();
  }
}

export async function requestLlmJson(options: {
  baseUrl: string;
  apiKey: string;
  path: 'models' | 'chat/completions';
  body?: Record<string, unknown>;
  loopbackHost?: string;
  timeoutMs?: number;
}) {
  try {
    const response = await fetch(
      llmRequestUrl(`${options.baseUrl}/${options.path}`, options.loopbackHost),
      {
        method: options.body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
      },
    );
    if (response.ok) return await readLlmJson(response);
    // Never return upstream bodies: they can echo credentials or request details.
    let detail: { error?: { code?: unknown; param?: unknown; message?: unknown } } = {};
    try {
      detail = await readLlmJson(response);
    } catch {
      /* Status remains useful without a JSON body. */
    }
    const status = response.status;
    const message =
      status >= 300 && status < 400
        ? 'LLM_REDIRECT_DISABLED'
        : status === 401
          ? 'LLM_AUTH_FAILED'
          : status === 403
            ? 'LLM_ACCESS_DENIED'
            : status === 429
              ? detail?.error?.code === 'insufficient_quota'
                ? 'LLM_QUOTA_EXCEEDED'
                : 'LLM_RATE_LIMITED'
              : status === 404
                ? options.path === 'models'
                  ? 'LLM_MODELS_UNSUPPORTED'
                  : 'LLM_MODEL_NOT_FOUND'
                : status === 400 &&
                    (detail?.error?.param === 'max_completion_tokens' ||
                      (typeof detail?.error?.message === 'string' &&
                        /max_completion_tokens/.test(detail.error.message) &&
                        /unsupported|unknown|unrecognized|not.*support/i.test(
                          detail.error.message,
                        )))
                  ? 'LLM_TOKEN_LIMIT_UNSUPPORTED'
                  : status === 400
                    ? 'LLM_REQUEST_REJECTED'
                    : 'LLM_UPSTREAM_FAILED';
    throw new TRPCError({ code: 'BAD_REQUEST', message });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message:
        error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
          ? 'LLM_TIMEOUT'
          : 'LLM_NETWORK_FAILED',
    });
  }
}

export async function testLlmModel(
  profile: { baseUrl: string; apiKey: string; model: string },
  loopbackHost?: string,
) {
  const start = Date.now();
  const body = {
    model: profile.model,
    messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
    stream: false,
  };
  const options = { ...profile, path: 'chat/completions' as const, loopbackHost, timeoutMs: 30000 };
  let response;
  try {
    response = await requestLlmJson({ ...options, body: { ...body, max_completion_tokens: 256 } });
  } catch (error) {
    if (!(error instanceof TRPCError) || error.message !== 'LLM_TOKEN_LIMIT_UNSUPPORTED')
      throw error;
    response = await requestLlmJson({ ...options, body: { ...body, max_tokens: 256 } });
  }
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim())
    throw new TRPCError({ code: 'BAD_GATEWAY', message: 'LLM_EMPTY_RESPONSE' });
  return { success: true as const, model: profile.model, latencyMs: Date.now() - start };
}
