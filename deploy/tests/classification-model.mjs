// Synthetic model fixture. Requests wait for an explicit test-controlled release.
import { createServer } from 'node:http';
let counter = 0;
const pending = new Map();
const history = [];
createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/stats') {
    res.end(JSON.stringify({ pending: [...pending.keys()], history }));
    return;
  }
  if (req.url === '/release') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { ids } = JSON.parse(raw);
    for (const id of ids) {
      const item = pending.get(id);
      if (!item) continue;
      pending.delete(id);
      item.res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: item.messages.map((message) => ({ id: message.id, category: 'primary' })) }) } }] }));
    }
    res.end('{}');
    return;
  }
  if (req.url !== '/v1/chat/completions') { res.statusCode = 404; res.end('{}'); return; }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const messages = JSON.parse(JSON.parse(raw).messages.at(-1).content);
  const id = ++counter;
  history.push({ id, subjects: messages.map((message) => message.subject) });
  pending.set(id, { messages, res });
  res.on('close', () => pending.delete(id));
}).listen(3000, '0.0.0.0');
