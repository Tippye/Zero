const fields = new Set(['to', 'cc', 'bcc', 'subject', 'body']);
export function normalizeServer(value, allowHttp = false) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Use a server origin, for example https://mail.example.com');
  if (url.protocol === 'http:' && !allowHttp)
    throw new Error('Enable HTTP explicitly for this server');
  return url.origin;
}
export function parseComposeLink(raw) {
  if (typeof raw !== 'string' || raw.length > 32000) throw new Error('Invalid compose link');
  const url = new URL(raw);
  const result = {};
  if (url.protocol === 'mailto:') result.to = decodeURIComponent(url.pathname);
  else if (
    url.protocol !== 'zeromail:' ||
    url.hostname !== 'compose' ||
    !['', '/'].includes(url.pathname)
  )
    throw new Error('Unsupported compose link');
  if (url.username || url.password || url.hash) throw new Error('Invalid compose link');
  // Decode each field once. A literal + in a mailto URI is not a form-encoded space.
  for (const part of url.search.slice(1).split('&').filter(Boolean)) {
    const separator = part.indexOf('=');
    const key = decodeURIComponent(separator < 0 ? part : part.slice(0, separator)).toLowerCase();
    if (!fields.has(key)) continue;
    const value = decodeURIComponent(separator < 0 ? '' : part.slice(separator + 1));
    result[key] = key === 'to' && result.to ? `${result.to},${value}` : value;
  }
  for (const [key, value] of Object.entries(result)) {
    if (value.includes('\0') || (key !== 'body' && /[\r\n]/.test(value)))
      throw new Error('Invalid compose field');
  }
  return result;
}
export function linkPath(raw) {
  if (/^zeromail:\/\/inbox\/?$/i.test(raw)) return '/mail/inbox';
  return '/mail/compose?' + new URLSearchParams(parseComposeLink(raw)).toString();
}
export function notificationPath(event) {
  if (
    !event ||
    typeof event.threadId !== 'string' ||
    !event.threadId.startsWith('mbx.') ||
    event.threadId.length > 4000
  )
    throw new Error('Invalid mail notification');
  return '/mail/inbox?' + new URLSearchParams({ threadId: event.threadId });
}
