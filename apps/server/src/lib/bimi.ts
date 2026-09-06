// BIMI is optional decoration: bound all external work and share public results by domain.
export type BimiResult = {
  domain: string;
  bimiRecord: { version?: string; logoUrl?: string; authorityUrl?: string } | null;
  logo: { url: string; svgContent: string } | null;
};

const TIMEOUT_MS = 2500;
const MAX_ENTRIES = 256;
const MAX_IN_FLIGHT = 20;
const MAX_SVG_BYTES = 128 * 1024;
const cache = new Map<string, { expires: number; value: BimiResult }>();
const pending = new Map<string, Promise<BimiResult>>();
const empty = (domain: string): BimiResult => ({ domain, bimiRecord: null, logo: null });

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > maxBytes)
    throw new Error('BIMI body too large');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let bytes = 0,
    text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error('BIMI body too large');
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function lookup(domain: string, signal: AbortSignal): Promise<BimiResult> {
  const result = empty(domain);
  const response = await fetch(
    `https://dns.google/resolve?name=${encodeURIComponent(`default._bimi.${domain}`)}&type=TXT`,
    { signal },
  );
  if (!response.ok) return result;
  const data = JSON.parse(await readLimited(response, 32 * 1024)) as {
    Status: number;
    Answer?: { data: string }[];
  };
  if (data.Status !== 0) return result;
  const record = data.Answer?.find((answer) => answer.data.includes('v=BIMI1'))?.data.replace(
    /"/g,
    '',
  );
  if (!record) return result;
  const parsed: NonNullable<BimiResult['bimiRecord']> = {};
  for (const part of record.split(';').map((value) => value.trim())) {
    if (part.startsWith('v=')) parsed.version = part.slice(2);
    if (part.startsWith('l=')) parsed.logoUrl = part.slice(2);
    if (part.startsWith('a=')) parsed.authorityUrl = part.slice(2);
  }
  if (parsed.version !== 'BIMI1') return result;
  result.bimiRecord = parsed;
  if (!parsed.logoUrl) return result;
  const url = new URL(parsed.logoUrl);
  if (url.protocol !== 'https:' || url.username || url.password) return result;
  const logo = await fetch(url.href, {
    signal,
    redirect: 'manual',
    headers: { Accept: 'image/svg+xml' },
  });
  if (!logo.ok || !logo.headers.get('content-type')?.includes('svg')) return result;
  const svgContent = await readLimited(logo, MAX_SVG_BYTES);
  if (svgContent.includes('<svg') && svgContent.includes('</svg>')) {
    result.logo = { url: url.href, svgContent };
  }
  return result;
}

export function getBimi(domain: string): Promise<BimiResult> {
  domain = domain.toLowerCase().replace(/\.$/, '');
  const cached = cache.get(domain);
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value);
  cache.delete(domain);
  const existing = pending.get(domain);
  if (existing) return existing;
  // Do not build an unbounded queue of optional lookups under load.
  if (pending.size >= MAX_IN_FLIGHT) return Promise.resolve(empty(domain));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<BimiResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(empty(domain));
    }, TIMEOUT_MS);
  });
  const work = Promise.race([lookup(domain, controller.signal).catch(() => empty(domain)), timeout])
    .then((value) => {
      // Cache misses too, so providers without BIMI do not generate repeated DNS requests.
      const ttl = value.logo ? 24 * 60 * 60_000 : 10 * 60_000;
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      cache.set(domain, { expires: Date.now() + ttl, value });
      return value;
    })
    .finally(() => {
      clearTimeout(timer);
      pending.delete(domain);
    });
  pending.set(domain, work);
  return work;
}
