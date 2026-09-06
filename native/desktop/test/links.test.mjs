import { parseComposeLink, linkPath, normalizeServer, notificationPath } from '../src/links.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

test('mailto preserves recipients, Unicode, plus, percent and encoded separators', () => {
  const parsed = parseComposeLink(
    'mailto:a%2Bb@example.com?cc=c@example.com&bcc=d@example.com&subject=%E4%BD%A0%E5%A5%BD%20%26%2050%25%20a+b&body=first%0D%0Asecond%3Fyes',
  );
  assert.deepEqual(parsed, {
    to: 'a+b@example.com',
    cc: 'c@example.com',
    bcc: 'd@example.com',
    subject: '你好 & 50% a+b',
    body: 'first\r\nsecond?yes',
  });
  assert.equal(
    new URL(linkPath('mailto:?subject=Hello'), 'https://example.com').searchParams.get('subject'),
    'Hello',
  );
});
test('custom compose and inbox links cannot change the configured server', () => {
  assert.equal(linkPath('zeromail://inbox'), '/mail/inbox');
  assert.equal(
    linkPath('zeromail://compose?to=a@example.com&subject=test'),
    '/mail/compose?to=a%40example.com&subject=test',
  );
  assert.throws(() => linkPath('zeromail://server?url=https://another.example'));
  assert.throws(() => linkPath('https://another.example'));
});
test('invalid encodings and header newlines are rejected; unknown fields are ignored', () => {
  assert.throws(() => parseComposeLink('mailto:a@example.com?subject=hello%0Aworld'));
  assert.throws(() => parseComposeLink('mailto:%ZZ'));
  assert.deepEqual(parseComposeLink('mailto:?attachment=file:///tmp/local'), { to: '' });
});
test('HTTP requires explicit opt-in; only server origins are accepted', () => {
  assert.equal(normalizeServer('https://mail.example.com/'), 'https://mail.example.com');
  assert.equal(normalizeServer('http://192.168.1.2:8080', true), 'http://192.168.1.2:8080');
  for (const url of [
    'http://localhost:8080',
    'file:///test',
    'https://user:pass@example.com',
    'https://example.com/path',
  ])
    assert.throws(() => normalizeServer(url));
});
test('notification links retain encoded mailbox ownership', () => {
  const path = notificationPath({ threadId: 'mbx.account.message%2Eid' });
  assert.equal(
    new URL(path, 'https://example.com').searchParams.get('threadId'),
    'mbx.account.message%2Eid',
  );
});
