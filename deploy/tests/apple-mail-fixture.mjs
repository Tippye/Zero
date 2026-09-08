import { createServer } from 'node:http';
const file = {
  attachmentId: 'attachment',
  filename: 'hello.txt',
  mimeType: 'text/plain',
  size: 5,
  body: 'aGVsbG8=',
  headers: [],
};
const account = {
  id: 'native-test-account',
  email: 'me@example.test',
  name: 'Synthetic mailbox',
  preset: 'custom',
  createdAt: new Date().toISOString(),
  saveSent: true,
};
const drafts = new Map(),
  operations = new Map(),
  flags = new Map();
function thread(id) {
  const draft = drafts.get(id);
  const labels = flags.get(id) || ['UNREAD'];
  const recipients = (value) =>
    (value || '')
      .split(',')
      .map((email) => email.trim())
      .filter(Boolean)
      .map((email) => ({ email }));
  const latest = {
    id,
    threadId: id,
    sender: { email: 'sender@example.test', name: 'Sender' },
    to: draft ? recipients(draft.to) : [{ email: account.email }],
    cc: draft ? recipients(draft.cc) : [],
    bcc: draft ? recipients(draft.bcc) : [],
    subject: draft?.subject || 'Native fixture',
    receivedOn: '2026-09-07T00:00:00Z',
    title: 'Native fixture',
    unread: labels.includes('UNREAD'),
    tags: labels.map((id) => ({ id, name: id })),
    tls: true,
    body: '',
    decodedBody: draft?.message || '<p>Hello &amp; welcome</p><script>blocked()</script>',
    processedHtml: '',
    blobUrl: '',
    attachments: draft?.attachments?.map((a, i) => ({
      attachmentId: 'draft-file-' + i,
      filename: a.name,
      mimeType: a.type,
      size: a.size,
      body: a.base64,
      headers: [],
    })) || [file],
    isDraft: !!draft,
  };
  return {
    messages: [latest],
    latest,
    labels: labels.map((id) => ({ id, name: id })),
    hasUnread: labels.includes('UNREAD'),
    totalReplies: 1,
  };
}
createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.headers.authorization !== 'Bearer synthetic-unused-bridge') {
    res.writeHead(401).end('{}');
    return;
  }
  try {
    let data = '';
    for await (const chunk of req) data += chunk;
    const { action, input, ownerId } = JSON.parse(data);
    if (!ownerId) throw Error('Missing owner');
    let result;
    if (action === 'accounts.list') result = [account];
    else {
      if (input.accountId !== account.id) throw Error('Unknown account');
      switch (action) {
        case 'mail.get':
          result = thread(input.id);
          break;
        case 'mail.modify':
          for (const id of input.ids) {
            flags.set(id, [
              ...new Set([
                ...(flags.get(id) || ['UNREAD']).filter(
                  (label) => !input.removeLabels.includes(label),
                ),
                ...input.addLabels,
              ]),
            ]);
          }
          result = { success: true };
          break;
        case 'mail.list':
          result = { threads: [], nextPageToken: null };
          break;
        case 'drafts.save': {
          const id = input.id || 'draft-' + (drafts.size + 1);
          drafts.set(id, input);
          result = { id };
          break;
        }
        case 'drafts.delete':
          drafts.delete(input.id);
          result = true;
          break;
        case 'mail.send': {
          const old = operations.get(input.operationId);
          if (old && old !== JSON.stringify(input))
            throw Object.assign(Error('Operation payload changed'), { status: 409 });
          operations.set(input.operationId, JSON.stringify(input));
          result = {
            id: 'sent',
            accepted: input.to.map((a) => a.email),
            rejected: [],
            sentCopySaved: true,
            replayed: !!old,
          };
          break;
        }
        default:
          throw Error('Unsupported fixture operation');
      }
    }
    res.end(JSON.stringify({ result }));
  } catch (error) {
    res
      .writeHead(error.status || 400)
      .end(
        JSON.stringify({ error: { code: 'FIXTURE_ERROR', message: 'Invalid synthetic request' } }),
      );
  }
}).listen(3033, '0.0.0.0');
