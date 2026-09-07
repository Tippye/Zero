import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '../android');
let tasks = process.argv.slice(2);
if (tasks.length === 1 && tasks[0] === 'release') {
  for (const name of [
    'ZERO_ANDROID_KEYSTORE',
    'ZERO_ANDROID_STORE_PASSWORD',
    'ZERO_ANDROID_KEY_ALIAS',
    'ZERO_ANDROID_KEY_PASSWORD',
  ]) {
    if (!process.env[name]) throw new Error(`Set ${name} before building a signed release.`);
  }
  tasks = ['assembleRelease', 'bundleRelease'];
}
if (!tasks.length || tasks.some((task) => !/^[a-zA-Z][a-zA-Z0-9]*$/.test(task))) {
  throw new Error('Expected Android Gradle task names.');
}
const windows = process.platform === 'win32';
const child = spawn(
  windows ? 'cmd.exe' : './gradlew',
  windows ? ['/d', '/c', 'gradlew.bat', ...tasks] : tasks,
  { cwd, stdio: 'inherit' },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
