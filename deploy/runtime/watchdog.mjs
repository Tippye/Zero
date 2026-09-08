import { readdir, readFile } from 'node:fs/promises';

// Measure workerd itself, not Node's heap (Miniflare runs the API in a child).
export async function workerResidentBytes() {
  let bytes = 0;
  for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
    try {
      if ((await readFile(`/proc/${pid}/comm`, 'utf8')).trim() !== 'workerd') continue;
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      bytes += Number(status.match(/VmRSS:\s+(\d+)/)?.[1] || 0) * 1024;
    } catch { /* The child can exit between the two reads. */ }
  }
  return bytes;
}

// Docker restart policies only see the parent process. Detect a dead workerd child.
export function startWatchdog({
  url,
  fail,
  request = fetch,
  intervalMs = 10000,
  timeoutMs = 3000,
  failures = 3,
  memoryUsage,
  maxResidentBytes = Infinity,
}) {
  let missed = 0,
    highMemory = 0,
    checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      if (memoryUsage) {
        const bytes = await memoryUsage();
        highMemory = bytes > maxResidentBytes ? highMemory + 1 : 0;
        if (highMemory >= failures) {
          clearInterval(timer);
          fail('memory', bytes);
          return;
        }
      }
      const response = await request(url, { signal: AbortSignal.timeout(timeoutMs) });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Unhealthy worker');
      missed = 0;
    } catch {
      if (++missed >= failures) {
        clearInterval(timer);
        fail('health');
      }
    } finally {
      checking = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
