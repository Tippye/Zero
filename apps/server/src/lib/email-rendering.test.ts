// @ts-ignore The IMAP bridge is a separate JavaScript service.
import { MailService } from '../../../../integrations/imap-bridge/src/mail.mjs';
// @ts-ignore The IMAP bridge is a separate JavaScript service.
import { messageId } from '../../../../integrations/imap-bridge/src/core.mjs';
import { processEmailHtml } from './email-processor';
import { decodeMessageBody } from './message-body';
import assert from 'node:assert/strict';
import sanitize from 'sanitize-html';
import * as cheerio from 'cheerio';
import { test } from 'node:test';

const part = (mimeType: string, body: string) => ({
  mimeType,
  body: { data: Buffer.from(body).toString('base64url') },
});
const newsletter =
  '<html><head><style>.card { padding-left: 24px; border-collapse: collapse; color: #123456; } body { font-size: 18px; }</style></head><body style="background-color:#fafafa" dir="ltr"><table class="card" width="600" cellpadding="12"><tr><td><h1>中文 &amp; HTML</h1><p>&lt;example&gt;</p><img src="cid:logo.1" alt="Logo"><img src="https://example.invalid/banner.png" alt="Banner"></td></tr></table></body></html>';

test('Gmail prefers nested HTML and preserves entities and Unicode exactly', () => {
  const result = decodeMessageBody({
    mimeType: 'multipart/mixed',
    parts: [
      part('text/plain', 'Fallback'),
      { mimeType: 'multipart/related', parts: [part('text/html', newsletter)] },
    ],
  });
  assert.equal(result, newsletter);
});

test('plain text keeps literal markup, ampersands and line breaks', () => {
  const result = decodeMessageBody({
    mimeType: 'multipart/alternative',
    parts: [part('text/plain', '你好 <example> &amp;\nsecond line')],
  });
  const $ = cheerio.load(result);
  assert.equal($('pre').text(), '你好 <example> &amp;\nsecond line');
  assert.equal($('example').length, 0);
  assert.equal(decodeMessageBody(), '');
});

test('IMAP and reader preserve newsletter layout and inline images while honoring external image preferences', async () => {
  const client = {
    mailbox: { uidValidity: 1n },
    on() {},
    connect: async () => {},
    logout: async () => {},
    close() {},
    getMailboxLock: async () => ({ release() {} }),
    list: async () => [],
    fetchOne: async (_uid: unknown, fields: { source?: boolean }) =>
      fields.source
        ? { source: Buffer.from('synthetic') }
        : { size: 9, flags: new Set(), internalDate: new Date(0) },
  };
  const service = new MailService(
    {
      createImap: () => client,
      sanitize,
      parseMail: async () => ({
        html: newsletter,
        attachments: [
          {
            cid: 'logo.1',
            contentType: 'image/png',
            content: Buffer.from('synthetic-image'),
            size: 15,
          },
        ],
      }),
    },
    null,
  );
  const mail = await service.get({}, messageId('INBOX', '1', 1));
  const result = processEmailHtml({
    html: mail.latest.decodedBody,
    theme: 'light',
    shouldLoadImages: false,
  });
  const $ = cheerio.load(result.processedHtml);
  assert.equal($('table.card').attr('cellpadding'), '12');
  assert.equal($('table.card').attr('width'), '600');
  assert.equal($('body').attr('dir'), 'ltr');
  assert.match($('body').attr('style') || '', /background-color/);
  assert.match($('style').text(), /padding-left: 24px/);
  assert.equal($('p').text(), '<example>');
  assert.match($('img').attr('src') || '', /^data:image\/png;base64,/);
  assert.equal($('img').length, 1);
  assert.equal(result.hasBlockedImages, true);
  const visible = processEmailHtml({
    html: mail.latest.decodedBody,
    theme: 'light',
    shouldLoadImages: true,
  });
  assert.equal(cheerio.load(visible.processedHtml)('img').length, 2);
  assert.equal(visible.hasBlockedImages, false);
});
