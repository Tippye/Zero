// Run inside the synthetic API container, never against a production inspector.
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const WebSocket = createRequire('/app/package.json')('ws');
const deadline = setTimeout(() => {
  console.error('Heap probe timed out');
  process.exit(1);
}, 60000);
const targets = await (await fetch('http://127.0.0.1:9229/json')).json();
const target = targets.find((t) => t.id === 'core:user:zero');
if (!target) throw new Error('No synthetic worker inspector');
const ws = new WebSocket(target.webSocketDebuggerUrl, { origin: 'http://localhost' });
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let id = 0;
const pending = new Map(),
  chunks = [];
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push(data.params.chunk);
  if (data.id) {
    const task = pending.get(data.id);
    if (!task) return;
    pending.delete(data.id);
    if (data.error) task.reject(new Error(JSON.stringify(data.error)));
    else task.resolve(data.result);
  }
};
const call = (method) =>
  new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method }));
  });
if (process.env.ZERO_CLEAR_CONSOLE === 'true') await call('Runtime.discardConsoleEntries');
await call('HeapProfiler.collectGarbage');
console.log(JSON.stringify(await call('Runtime.getHeapUsage')));
if (process.argv[2]) {
  await call('HeapProfiler.takeHeapSnapshot');
  await writeFile(process.argv[2], chunks.join(''));
}
ws.terminate();
clearTimeout(deadline);
process.exit(0);
