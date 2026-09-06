// Bundle like the Worker: css-sanitizer ships ESM syntax without ESM package metadata.
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { createRequire } = require('node:module');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const esbuild = createRequire(require.resolve('tsx/package.json'))('esbuild');
const directory = mkdtempSync(join(tmpdir(), 'zero-email-rendering-'));
try {
  const outfile = join(directory, 'tests.cjs');
  esbuild.buildSync({
    entryPoints: [resolve(__dirname, '../apps/server/src/lib/email-rendering.test.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
  });
  const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
