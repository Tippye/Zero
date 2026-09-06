import { toByteArray } from 'base64-js';

interface BodyPart {
  mimeType?: string | null;
  filename?: string | null;
  body?: { data?: string | null } | null;
  parts?: BodyPart[] | null;
}

// MIME type, not the presence of angle brackets, determines how text is rendered.
export function decodeMessageBody(payload?: BodyPart | null): string {
  const find = (part: BodyPart | null | undefined, mimeType: string): string | undefined => {
    if (!part || part.filename) return;
    if (part.mimeType?.toLowerCase() === mimeType && part.body?.data) return part.body.data;
    for (const child of part.parts || []) {
      const data = find(child, mimeType);
      if (data) return data;
    }
  };
  const html = find(payload, 'text/html');
  const encoded = html || find(payload, 'text/plain');
  if (!encoded) return '';
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const text = new TextDecoder().decode(
    toByteArray(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')),
  );
  if (html) return text;
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit">${escaped}</pre>`;
}
