// Loopback-only synthetic mail service for native UI tests. No external mailbox
// or model connections, and no production credentials are accepted or logged.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.ZERO_UI_PORT || 19280);
const origin = `http://localhost:${port}`;
const account = { id: 'ui-test', email: 'me@example.test', name: 'UI Test', providerId: 'imap', connected: true };
let drafts, sent, flags, requests, actions, aiMode, htmlCase;
function reset() {
  drafts = new Map(); sent = []; flags = { unread: true, starred: false, folder: 'inbox' }; requests = []; actions = []; aiMode = {}; htmlCase = '';
}
reset();
const attachment = { attachmentId: 'attachment-1', filename: 'sample.txt', mimeType: 'text/plain', size: 5 };
const summary = () => ({ id: 'mbx.ui-test.message-1', accountId: account.id, accountEmail: account.email,
  subject: 'Apple UI fixture', sender: { email: 'sender@example.test', name: 'Fixture Sender' },
  receivedOn: '2026-09-08T00:00:00Z', snippet: 'Synthetic mail for Apple validation',
  unread: flags.unread, starred: flags.starred, isDraft: false });
const readBody = async (request) => {
  const parts = []; let size = 0;
  for await (const part of request) { size += part.length; if (size > 24 * 1024 * 1024) throw new Error('too_large'); parts.push(part); }
  const raw = Buffer.concat(parts).toString(); return raw ? JSON.parse(raw) : {};
};
http.createServer(async (request, response) => {
  const reply = (value, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  try {
    const body = await readBody(request);
    const path = new URL(request.url, origin).pathname;
    if (path === '/__test/reset') { reset(); return reply({ ready: true }); }
    if (path === '/__test/configure') { aiMode = { legacy: body.legacy === true, cacheUnavailable: body.cacheUnavailable === true }; htmlCase = body.htmlCase || ''; return reply({ ready: true }); }
    if (path === '/__test/state') return reply({ drafts: [...drafts.values()], sent, flags, requests, actions });
    if (path === '/__test/tracker') { requests.push('remote-content-loaded'); return reply({ tracked: true }); }
    if (path === '/api/pairing/start') return reply({ requestId: randomUUID(), deviceSecret: 'synthetic-only',
      userCode: 'TEST-ONLY', expiresAt: new Date(Date.now() + 300_000).toISOString(), interval: 5,
      verificationUri: origin + '/pair', verificationUriComplete: origin + '/pair#code=TEST-ONLY' });
    if (path === '/api/pairing/exchange') return reply({ status: 'authorized', token: 'synthetic-ui-token' });
    if (request.headers.authorization !== 'Bearer synthetic-ui-token') return reply({ error: 'unauthorized' }, 401);
    if (path === '/api/auth/sign-out') return reply({ success: true });
    if (path === '/api/pairing/devices') return reply({ devices: [{ id: 'ui-session', name: 'UI Test', current: true,
      createdAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00Z' }] });
    if (path.startsWith('/api/trpc/')) {
      const procedure = path.slice('/api/trpc/'.length); requests.push('web:' + procedure);
      const input = request.method === 'GET' ? JSON.parse(new URL(request.url, origin).searchParams.get('input') || '{}').json : body.json;
      const success = value => reply({ result: { data: { json: value } } });
      const failure = (code, httpStatus) => reply({ error: { json: { message: code, code: -32603, data: { code, httpStatus, path: procedure } } } }, httpStatus);
      if (procedure === 'llm.list') return success({ ready: true, activeId: 'fixture', profiles: [{ id: 'fixture', name: 'Fixture AI', model: 'synthetic' }] });
      if (procedure === 'ai.translation') return aiMode.cacheUnavailable ? failure('INTERNAL_SERVER_ERROR', 500) : success(null);
      if (procedure === 'ai.read') return success({ text: input.action === 'ask' ? 'Synthetic answer' : 'Synthetic mail summary',
        translation: input.action === 'translate' ? { subject: '测试译文', html: '<p>合成翻译正文</p>', language: input.language, expiresAt: Date.now() + 60_000 } : null });
      if (procedure === 'imap.generate' && input.task === 'compose' && input.consent === true) return success({ text: 'Synthetic AI draft for review', model: 'synthetic' });
      return failure('NOT_FOUND', 404);
    }
    const operation = path.replace('/api/native/v1/', ''); requests.push(operation);
    if (aiMode.legacy && operation.startsWith('ai-')) return reply({ error: 'NOT_FOUND' }, 404);
    switch (operation) {
      case 'accounts': return reply({ accounts: [account] });
      case 'threads': {
        let rows = body.folder === 'draft' ? [...drafts].map(([id, draft]) => ({ ...summary(), id,
          subject: draft.subject || 'Untitled draft', snippet: draft.text, unread: false, isDraft: true }))
          : body.folder === flags.folder || body.folder === 'starred' && flags.starred ? [summary()] : [];
        if (body.q) rows = rows.filter(row => (row.subject + row.snippet).toLowerCase().includes(body.q.toLowerCase()));
        return reply({ threads: rows, cursor: null, warnings: [] });
      }
      case 'thread': return reply({ id: summary().id, unread: flags.unread, starred: flags.starred, messages: [{
        id: summary().id, sender: summary().sender, to: [{ email: account.email }], cc: [], bcc: [],
        subject: summary().subject, receivedOn: summary().receivedOn,
        text: htmlCase === 'html-only' ? '' : htmlCase ? 'Plain fallback only' : 'Synthetic mail for Apple validation',
        html: htmlCase === 'text-only' ? '' : htmlCase ? `<!doctype html><html><head><style>h2{color:#1d4ed8}table{border-collapse:collapse;width:100%;background:#eff6ff}td,th{padding:12px;border:1px solid #93c5fd;text-align:left}</style></head><body><h2>Order confirmation</h2><table><tr><th>Item</th><th>Total</th></tr><tr><td>HTML receipt</td><td>$42.00</td></tr></table>${htmlCase === 'long' ? Array.from({length:30}, (_, i) => `<p>Paragraph ${i + 1}: This formatted email should resize with the reading pane and remain scrollable without hiding the reply controls.</p>`).join('') : ''}<p>End of formatted email</p><img src="${origin}/__test/tracker"><script>document.body.innerHTML="UNSAFE SCRIPT"</script></body></html>` : `<p>Synthetic mail for Apple validation</p><img src="${origin}/__test/tracker"><script>document.body.innerHTML="UNSAFE SCRIPT"</script>`,
        messageId: '<ui-1@example.test>', isDraft: false, attachments: [attachment] }] });
      case 'attachments': return reply({ attachments: [{ ...attachment, body: 'aGVsbG8=' }] });
      case 'action':
        actions.push({ action: body.action, ids: [...(body.ids || [])] });
        if (['read', 'unread'].includes(body.action)) flags.unread = body.action === 'unread';
        if (['star', 'unstar'].includes(body.action)) flags.starred = body.action === 'star';
        if (['archive', 'trash'].includes(body.action)) flags.folder = body.action;
        return reply({ success: true });
      case 'save-draft': {
        const id = body.draftId || 'mbx.ui-test.draft-' + randomUUID();
        const draft = { id, to: body.to.map(x => x.email), cc: body.cc.map(x => x.email), bcc: body.bcc.map(x => x.email),
          subject: body.subject, content: body.message, text: body.message.replace(/<[^>]*>/g, ''), attachments: [] };
        drafts.set(id, draft); return reply({ id });
      }
      case 'draft': return drafts.has(body.id) ? reply(drafts.get(body.id)) : reply({ error: 'not_found' }, 404);
      case 'delete-draft': drafts.delete(body.id); return reply({ success: true });
      case 'send': sent.push({ subject: body.subject, to: body.to, cc: body.cc, bcc: body.bcc, operationId: body.operationId });
        if (body.draftId) drafts.delete(body.draftId); return reply({ success: true });
      case 'sync': return reply({ success: true });
      case 'ai-status': return aiMode.legacy ? reply({ error: 'NOT_FOUND' }, 404) : reply({ ready: true, name: 'Fixture AI', model: 'synthetic' });
      case 'ai-translation': return aiMode.cacheUnavailable ? reply({ error: 'mailbox_unavailable' }, 502) : reply({ translation: null });
      case 'ai-read': return reply({ text: body.action === 'ask' ? 'Synthetic answer' : 'Synthetic mail summary',
        translation: body.action === 'translate' ? { subject: '测试译文', html: '<p>合成翻译正文</p>', text: '合成翻译正文', language: body.language, expiresAt: Date.now() + 60_000 } : null });
      case 'ai-compose': return body.consent === true ? reply({ text: 'Synthetic AI draft for review', model: 'synthetic' }) : reply({ error: 'consent_required' }, 400);
      case 'events': return reply({ owner: 'ui-owner', cursor: '0', events: [] });
      default: return reply({ error: 'not_found' }, 404);
    }
  } catch { reply({ error: 'invalid_request' }, 400); }
}).listen(port, '127.0.0.1', () => process.stdout.write(`Synthetic Apple UI fixture listening on ${origin}\n`));
