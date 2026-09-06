import test from 'node:test';
import assert from 'node:assert/strict';
import { MailService } from '../src/mail.mjs';
import { messageId } from '../src/core.mjs';

const account = { imapHost: 'imap.qq.com', username: 'a@qq.com', password: 'code', email: 'a@qq.com', name: 'A', smtpHost: 'smtp.qq.com', smtpPort: 587 };
function fake(overrides = {}) {
  const events = [];
  const client = {
    mailbox: { uidValidity: 42n, exists: 3 }, capabilities: new Map([['MOVE', true]]),
    on() {}, connect: async () => { events.push('connect'); }, logout: async () => { events.push('logout'); }, close: () => events.push('close'),
    list: async () => [{ path: 'INBOX', flags: new Set() }, { path: '已删除', specialUse: '\\Trash', flags: new Set() }, { path: 'Sent', flags: new Set() }],
    getMailboxLock: async () => ({ release: () => events.push('unlock') }),
    search: async (query, options) => { events.push({ query, options }); return [1, 3, 7]; },
    fetchAll: async (uids, _fields, options) => { events.push({ uids, options }); const selected = options.uid ? uids.split(',').map(Number) : [1, 3, 7].slice(Number(uids.split(':')[0]) - 1, Number(uids.split(':')[1])); return selected.map(uid => ({ uid, envelope: { subject: `Mail ${uid}` } })); },
    fetchOne: async (_uid, fields) => fields.source ? { source: Buffer.from('test-mail') } : { uid: Number(_uid), seq: [1, 3, 7].indexOf(Number(_uid)) + 1, size: 9, flags: new Set(), internalDate: new Date(0) },
    messageFlagsAdd: async () => events.push('flags-add'), messageFlagsRemove: async () => events.push('flags-remove'),
    messageMove: async () => events.push('move'),
    ...overrides,
  };
  const service = new MailService({ createImap: (config) => { events.push(config); return client; },
    mailer: { createTransport: (config) => { events.push(config); return { close() {} }; } },
    parseMail: async () => ({ subject: '测试邮件', from: { value: [{ address: 'a@b.com' }] }, to: [{ value: [{ address: 'c@d.com' }] }], text: '<script>alert(1)</script>', attachments: [] }),
    sanitize: (s) => s,
  }, null);
  return { service, client, events };
}
test('listing uses UIDs and returns validity-bound cursor', async () => {
  const { service, events } = fake();
  const page = await service.list(account, { folder: 'inbox', maxResults: 2 });
  assert.deepEqual(page.threads.map((x) => x.id), [messageId('INBOX', '42', 7), messageId('INBOX', '42', 3)]);
  assert.equal(page.nextPageToken, messageId('INBOX', '42', 3));
  assert.ok(events.some((e) => e.uids === '1:3' && e.options.uid === false));
  assert.deepEqual(events.slice(-3), ['unlock', 'logout', 'close']);
});
test('cursor mismatch and UIDVALIDITY reset fail without fetching message content', async () => {
  const { service, events } = fake();
  await assert.rejects(service.list(account, { pageToken: messageId('INBOX', '41', 7) }), (e) => e.code === 'STALE_CURSOR');
  await assert.rejects(service.get(account, messageId('INBOX', '41', 7)), (e) => e.code === 'STALE_UIDVALIDITY');
  assert.equal(events.filter((e) => e.uids).length, 0);
});
test('empty mailbox does not accidentally issue IMAP 1:* fetch', async () => {
  const { service, events } = fake({ mailbox: { uidValidity: 42n, exists: 0 } });
  assert.deepEqual(await service.list(account), { threads: [], nextPageToken: null });
  assert.equal(events.filter((e) => e.uids).length, 0);
});
test('Chinese special-use and literal folder names resolve correctly', async () => {
  const { service, client } = fake();
  assert.equal(await service.resolveFolder(client, 'bin'), '已删除');
  assert.equal(await service.resolveFolder(client, 'Sent'), 'Sent');
  await assert.rejects(service.resolveFolder(client, 'archive'), (e) => e.code === 'FOLDER_NOT_FOUND');
});
test('missing messages and oversized MIME source fail closed', async () => {
  const { service } = fake({ fetchOne: async () => false });
  await assert.rejects(service.get(account, messageId('INBOX', '42', 7)), (e) => e.code === 'MESSAGE_NOT_FOUND');
  const huge = fake({ fetchOne: async () => ({ size: 11 * 1024 * 1024 }) });
  await assert.rejects(huge.service.get(account, messageId('INBOX', '42', 7)), (e) => e.code === 'MESSAGE_TOO_LARGE');
});
test('read flags use UID mode and atomic MOVE is required before mutating flags', async () => {
  const { service, events } = fake({ capabilities: new Map() });
  await assert.rejects(service.modify(account, [messageId('INBOX', '42', 7)], ['TRASH'], ['UNREAD']), (e) => e.code === 'NOT_SUPPORTED');
  assert.ok(!events.includes('flags-add') && !events.includes('move'));
  await service.modify(account, [messageId('INBOX', '42', 7)], [], ['UNREAD']);
  assert.ok(events.includes('flags-add'));
});
test('MIME conversion handles multi-value addresses and escapes text-only content', async () => {
  const { service } = fake();
  const result = await service.get(account, messageId('INBOX', '42', 7));
  assert.deepEqual(result.latest.to, [{ name: '', email: 'c@d.com' }]);
  assert.ok(result.latest.processedHtml.includes('&lt;script&gt;'));
  assert.equal(result.hasUnread, true);
});
test('all protocol connections verify TLS; port 587 requires STARTTLS', async () => {
  const { service, events } = fake();
  await service.list(account); service.smtp(account);
  const imap = events.find((e) => e?.host === 'imap.qq.com');
  const smtp = events.find((e) => e?.host === 'smtp.qq.com');
  assert.equal(imap.tls.rejectUnauthorized, true); assert.equal(imap.logger, false);
  assert.equal(smtp.requireTLS, true); assert.equal(smtp.tls.rejectUnauthorized, true);
});
test('outgoing messages reject spoofing, CRLF, URL attachments, and excessive recipients', () => {
  const { service } = fake(); const data = { to: [{ email: 'b@c.com' }], subject: 'Test', message: 'Body' };
  assert.throws(() => service.outgoing(account, { ...data, fromEmail: 'other@x.com' }));
  assert.throws(() => service.outgoing(account, { ...data, subject: 'x\r\nBcc: evil@x.com' }));
  assert.throws(() => service.outgoing(account, { ...data, attachments: [{ name: 'a', base64: 'https://example.com' }] }));
  assert.throws(() => service.outgoing(account, { ...data, to: Array.from({ length: 101 }, () => ({ email: 'b@c.com' })) }));
  const valid = service.outgoing(account, data);
  assert.equal(valid.from.address, 'a@qq.com'); assert.equal(valid.disableUrlAccess, true);
});
test('outgoing messages keep blind recipients only in the SMTP envelope', () => {
  const { service } = fake();
  const valid = service.outgoing(account, {
    to: [{ email: 'visible@example.com' }], bcc: [{ email: 'hidden@example.com' }],
    subject: 'Private recipients', message: 'Body',
  });
  assert.deepEqual(valid.envelope, {
    from: 'a@qq.com', to: ['visible@example.com', 'hidden@example.com'],
  });
  assert.equal('bcc' in valid, false);
});

test('draft save appends before removing the previous UID and retains Bcc in the draft', async () => {
  const writes = [];
  const { service } = fake({
    capabilities: new Map([['UIDPLUS', true]]),
    list: async () => [{ path: '草稿箱', specialUse: '\\Drafts' }],
    append: async (folder, raw, flags) => { writes.push({ folder, raw, flags }); return { uid: 9 }; },
    messageDelete: async (uid, options) => writes.push({ uid, options }),
  });
  service.mailer = { createTransport: () => ({ close() {}, sendMail: async mail => { assert.equal(mail.bcc[0].address, 'hidden@example.invalid'); return { message: Buffer.from('synthetic MIME') }; } }) };
  const result = await service.saveDraft(account, { id: messageId('草稿箱', '42', 7), to: '', bcc: 'hidden@example.invalid', subject: 'Synthetic draft', message: 'Body' });
  assert.equal(result.id, messageId('草稿箱', '42', 9));
  assert.deepEqual(writes[0].flags, ['\\Draft', '\\Seen']);
  assert.equal(writes[1].uid, 7); assert.equal(writes[1].options.uid, true);
});
test('failed draft append preserves the previous draft; non-drafts cannot be deleted', async () => {
  let deletes = 0;
  const { service } = fake({ capabilities: new Map([['UIDPLUS', true]]),
    list: async () => [{ path: 'Drafts', specialUse: '\\Drafts' }],
    append: async () => { throw Error('synthetic failure'); }, messageDelete: async () => deletes++,
  });
  service.mailer = { createTransport: () => ({ close() {}, sendMail: async () => ({ message: Buffer.from('synthetic MIME') }) }) };
  await assert.rejects(service.saveDraft(account, { id: messageId('Drafts', '42', 7), to: '', subject: 'Subject only', message: '' }));
  assert.equal(deletes, 0);
  await assert.rejects(service.deleteDraft(account, messageId('INBOX', '42', 7)));
  assert.equal(deletes, 0);
});

test('confirmed SMTP delivery removes its draft once; uncertain delivery preserves it', async () => {
  for (const fail of [false, true]) {
    const records = new Map(), events = [];
    const { service } = fake();
    service.vault = { exclusive: async (_key, fn) => fn(), get: async (_owner, kind, id) => records.get(kind + id), put: async (_owner, kind, id, value) => records.set(kind + id, value) };
    service.mailer = { createTransport: () => ({ close() {}, sendMail: async mail => ({ envelope: mail.envelope, message: Buffer.from('synthetic MIME') }) }) };
    service.smtp = () => ({ close() {}, sendMail: async () => { events.push('smtp'); if (fail) throw Error('synthetic timeout'); return { accepted: ['target@example.invalid'], rejected: [] }; } });
    service.deleteDraft = async () => events.push('draft-remove');
    const input = { operationId: 'synthetic-operation-123', to: [{ email: 'target@example.invalid' }], subject: 'Synthetic', message: 'Synthetic', draftId: 'synthetic-draft' };
    if (fail) {
      await assert.rejects(service.send('owner', 'account', account, input));
      await assert.rejects(service.send('owner', 'account', account, input));
      assert.deepEqual(events, ['smtp']);
    } else {
      const first = await service.send('owner', 'account', account, input);
      const replay = await service.send('owner', 'account', account, input);
      assert.equal(first.draftRemoved, true); assert.equal(replay.replayed, true);
      assert.deepEqual(events, ['smtp', 'draft-remove']);
    }
  }
});

test('unfiltered pages avoid full mailbox SEARCH and keep stable UID pagination', async () => {
  const { service, events } = fake();
  const first = await service.list(account, { folder: 'inbox', maxResults: 2 });
  const second = await service.list(account, { folder: 'inbox', maxResults: 2, pageToken: first.nextPageToken });
  assert.deepEqual(second.threads.map(x => x.id), [messageId('INBOX', '42', 1)]);
  assert.equal(second.nextPageToken, null);
  assert.equal(events.filter(e => e.query).length, 0);
});
test('deleted pagination anchor uses UID search; filters still search correctly', async () => {
  const { service, events } = fake({ fetchOne: async () => false });
  const page = await service.list(account, { folder: 'inbox', pageToken: messageId('INBOX', '42', 7), maxResults: 2 });
  assert.deepEqual(page.threads.map(x => x.id), [messageId('INBOX', '42', 3), messageId('INBOX', '42', 1)]);
  assert.ok(events.some(e => e.query?.uid === '1:6'));
  await service.list(account, { folder: 'inbox', labelIds: ['UNREAD'] });
  assert.ok(events.some(e => e.query?.seen === false));
});
test('large inbox only fetches the final page plus one envelope', async () => {
  let range;
  const { service } = fake({ mailbox: { uidValidity: 42n, exists: 100000 }, search: async () => { throw Error('must not scan'); }, fetchAll: async (r, fields, options) => {
    range = r; assert.equal(options.uid, false); assert.equal(fields.source, undefined);
    return Array.from({ length: 21 }, (_, i) => ({ uid: 99980 + i, envelope: {} }));
  } });
  const page = await service.list(account, { folder: 'inbox', maxResults: 20 });
  assert.equal(range, '99980:100000'); assert.equal(page.threads.length, 20); assert.ok(page.nextPageToken);
});

test('authorization failures and timeouts are distinguishable without leaking provider text', async () => {
  for (const [error, code] of [[Object.assign(Error('sensitive provider response'), { authenticationFailed: true }), 'AUTH_FAILED'], [Object.assign(Error('sensitive provider response'), { code: 'ETIMEDOUT' }), 'UPSTREAM_TIMEOUT']]) {
    const { service } = fake({ connect: async () => { throw error; } });
    await assert.rejects(service.list(account), e => e.code === code && !e.message.includes('sensitive'));
  }
});
test('background snapshot reuses one read-only connection and bounds envelope windows', async () => {
  const locks=[];
  const { service, events }=fake({getMailboxLock:async(path,options)=>{locks.push({path,options});return {release(){}};}});
  const result=await service.snapshot(account,{limit:50});
  assert.equal(events.filter(e=>e==='connect').length,1);
  assert.ok(locks.every(l=>l.options.readOnly===true));
  assert.equal(events.filter(e=>e.query).length,0);
  assert.equal(result.folders.find(f=>f.folder==='inbox').threads.length,3);
  assert.deepEqual(result.folders.find(f=>f.folder==='archive').threads,[]);
});
