import {
  translationDocument,
  translationBatches,
  parseTranslation,
  translationMessages,
} from './mail-translation';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { test } from 'node:test';

const html =
  '<html><head><style>.card { color: blue; }</style></head><body class="mail"><table width="600"><tr><td style="padding:12px"> Hello <b>world</b>! <a href="https://example.invalid/original">Visit</a><img src="cid:logo" alt="Logo"></td></tr></table></body></html>';

test('only text and textual attributes change; layout, CSS, images and links remain identical', () => {
  const document = translationDocument(html, 'Subject');
  const result = document.apply(
    document.segments.map((segment) => ({ id: segment.id, text: `译文${segment.id}` })),
  );
  const original = cheerio.load(html),
    translated = cheerio.load(result.html);
  assert.equal(result.subject, '译文0');
  assert.equal(translated('style').html(), original('style').html());
  for (const selector of ['body', 'table', 'td', 'b', 'a']) {
    assert.deepEqual(translated(selector).attr(), original(selector).attr());
  }
  assert.equal(translated('img').attr('src'), 'cid:logo');
  assert.match(translated('img').attr('alt') || '', /译文/);
  assert.equal(translated('body *').length, original('body *').length);
  assert.match(translated('td').html() || '', /^ 译文1 <b>/);
  assert.ok(!document.segments.some((segment) => segment.text.includes('.card')));
});

test('model text is escaped rather than inserted as generated HTML', () => {
  const document = translationDocument('<p>Hello</p>', 'Subject');
  const result = document.apply(
    document.segments.map((segment) => ({ id: segment.id, text: '<b>文字</b> & 内容' })),
  );
  const $ = cheerio.load(result.html);
  assert.equal($('b').length, 0);
  assert.equal($('p').text(), '<b>文字</b> & 内容');
});

test('missing, duplicated, unknown and empty translations are rejected without caching partial output', () => {
  const document = translationDocument('<p>Hello</p>', 'Subject');
  for (const values of [
    [],
    [
      { id: 0, text: 'a' },
      { id: 0, text: 'b' },
    ],
    [
      { id: 0, text: 'a' },
      { id: 9, text: 'b' },
    ],
    [
      { id: 0, text: 'a' },
      { id: 1, text: '' },
    ],
  ]) {
    assert.throws(
      () => parseTranslation(JSON.stringify({ translations: values }), document.segments),
      /INVALID_TRANSLATION/,
    );
  }
  const values = document.segments.map((segment) => ({ ...segment, text: '翻译' }));
  assert.deepEqual(
    parseTranslation(JSON.stringify({ translations: values }), document.segments),
    values,
  );
});

test('batches keep every segment and prompts contain text rather than the HTML document', () => {
  const document = translationDocument(html, 'Subject');
  assert.deepEqual(translationBatches(document.segments).flat(), document.segments);
  const messages = translationMessages('zh-CN', document.segments);
  assert.match(messages[0].content, /zh-CN/);
  assert.doesNotMatch(messages[1].content, /<table|padding:|cid:logo/);
  assert.throws(() => translationDocument('<p> </p>', ''), /MAIL_AI_EMPTY/);
  assert.throws(
    () => translationDocument('<p>' + 'a'.repeat(80001) + '</p>', ''),
    /MAIL_AI_TOO_LONG/,
  );
});

test('long paragraphs are chunked without changing their HTML node or losing any text', () => {
  const text = 'A long paragraph with words. '.repeat(600);
  const document = translationDocument(`<p>${text}</p>`, '');
  assert.ok(document.segments.length > 1);
  assert.ok(
    translationBatches(document.segments).every(
      (batch) => batch.reduce((sum, item) => sum + item.text.length, 0) <= 6000,
    ),
  );
  const result = document.apply(document.segments);
  const $ = cheerio.load(result.html);
  assert.equal($('p').text(), text);
  assert.equal($('p').contents().length, 1);
});
