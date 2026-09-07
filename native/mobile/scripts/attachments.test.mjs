import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const script = await readFile(
  new URL('../android/app/src/main/assets/attachments.js', import.meta.url),
  'utf8',
);
function fixture({ rejectChunk = false, size } = {}) {
  const messages = [],
    alerts = [];
  let click, done;
  const completion = new Promise((resolve) => {
    done = resolve;
  });
  const bridge = {
    postMessage(raw) {
      const message = JSON.parse(raw);
      messages.push(message);
      const error = rejectChunk && message.type === 'chunk' ? 'Transfer rejected' : undefined;
      queueMicrotask(() => {
        bridge.onmessage({ data: JSON.stringify({ id: message.id, error }) });
        if (message.type === 'finish' || message.type === 'abort') done();
      });
    },
  };
  class Reader {
    async readAsDataURL(blob) {
      this.result = `data:application/octet-stream;base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
      this.onload();
    }
  }
  const context = {
    ZeroAttachments: bridge,
    crypto: webcrypto,
    URL: { createObjectURL: () => 'blob:http://server/attachment', revokeObjectURL() {} },
    document: {
      addEventListener(name, callback) {
        if (name === 'click') click = callback;
      },
    },
    setTimeout,
    clearTimeout,
    FileReader: Reader,
    alert(message) {
      alerts.push(message);
    },
    open() {},
    fetch() {
      throw new Error('Revoked blob URL must not be fetched');
    },
  };
  context.window = context;
  context.top = context;
  vm.runInNewContext(script, context);
  const bytes = Buffer.from('中文附件\n'.repeat(16000));
  const blob = size ? { size } : new Blob([bytes], { type: 'text/plain' });
  const url = context.URL.createObjectURL(blob);
  function download() {
    let prevented = false;
    click({
      target: { closest: () => ({ href: url, download: '中文.txt', hasAttribute: () => true }) },
      preventDefault() {
        prevented = true;
      },
    });
    context.URL.revokeObjectURL(url);
    assert.equal(prevented, true);
  }
  return { download, completion, messages, alerts, bytes };
}
test('downloads the exact blob bytes after the web app revokes its URL, including multiple chunks', async () => {
  const f = fixture();
  f.download();
  await f.completion;
  assert.equal(f.messages[0].name, '中文.txt');
  assert.equal(f.messages[0].size, f.bytes.length);
  const chunks = f.messages.filter((message) => message.type === 'chunk');
  assert.ok(chunks.length > 1);
  assert.deepEqual(
    chunks.map((chunk) => chunk.seq),
    chunks.map((_, index) => index),
  );
  assert.deepEqual(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, 'base64'))),
    f.bytes,
  );
  assert.equal(f.messages.at(-1).type, 'finish');
  assert.deepEqual(f.alerts, []);
});
test('a rejected native chunk aborts the transfer instead of reporting success', async () => {
  const f = fixture({ rejectChunk: true });
  f.download();
  await f.completion;
  assert.equal(f.messages.filter((message) => message.type === 'finish').length, 0);
  assert.equal(f.messages.at(-1).type, 'abort');
  assert.deepEqual(f.alerts, ['Transfer rejected']);
});
test('oversize attachments are rejected before sending bytes', async () => {
  const f = fixture({ size: 25 * 1024 * 1024 + 1 });
  f.download();
  await f.completion;
  assert.deepEqual(
    f.messages.map((message) => message.type),
    ['abort'],
  );
  assert.equal(f.alerts.length, 1);
});
