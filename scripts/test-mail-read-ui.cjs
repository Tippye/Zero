// Exercises real mail hooks and React Query with synthetic transport. No network.
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const esbuild = createRequire(require.resolve('tsx/package.json'))('esbuild');
const { chromium } = createRequire(resolve(__dirname, '../packages/testing/package.json'))(
  '@playwright/test',
);
const app = resolve(__dirname, '../apps/mail');
const mocks = {
  '@/providers/query-provider': `const trpc={mail:{get:{queryOptions:(input,options)=>({queryKey:['get',input],queryFn:async()=>{window.reads++;if(input.id.includes('backoff')){const attempts=window.attempts[input.id]??=[];attempts.push(Date.now());if(!input.id.includes('recover')||attempts.length<3)throw Object.assign(new Error('BUSY'),{data:{code:'TOO_MANY_REQUESTS',httpStatus:429},meta:{response:{headers:new Headers(input.id.includes('minute')?{'Retry-After':'60'}:{})}}});}await new Promise(r=>setTimeout(r,20));if(input.id.includes('fail'))throw new Error('BUSY');return {messages:[{id:input.id,attachments:[],sender:{email:'synthetic@example.invalid'}}],latest:{id:input.id},labels:[]};},...options})},getMessageAttachments:{queryOptions:(input,options)=>({queryKey:['attachments',input],queryFn:async()=>{window.attachments++;return [];},...options})}}};export const useTRPC=()=>trpc;`,
  './use-mailboxes': `export const useMailboxes=()=>({data:[{id:'a',providerId:'imap'}]});export const splitMailboxId=id=>id?{accountId:'a',id}:null;export const useMailboxScope=()=>undefined;`,
  '@/lib/auth-client': `export const useSession=()=>({data:{user:{id:'owner'}}});`,
  '@/hooks/use-search-value': `export const useSearchValue=()=>[{value:''}];`,
  './use-labels-search': `export default ()=>({labels:[]});`,
  '@/store/backgroundQueue': `export const backgroundQueueAtom=null,isThreadInBackgroundQueueAtom=null;`,
  'react-router': `export const useParams=()=>({folder:'inbox'});`,
};
(async () => {
  const build = await esbuild.build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {useThread} from './hooks/use-threads';import {useAttachments} from './hooks/use-attachments';window.reads=0;window.attachments=0;window.attempts={};const cache=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});const root=createRoot(document.getElementById('root'));let epoch=0;function Reader({id}){const query=useThread(id);useAttachments(id||'',[]);return <span>{query.error?'failed':query.data?'loaded':'pending'}</span>}window.mountReaders=(count,id,reset=false)=>{if(reset)epoch++;root.render(<QueryClientProvider client={cache}>{Array.from({length:count},(_,i)=><Reader key={epoch+':'+i} id={id}/>)}</QueryClientProvider>)};window.mountReaders(1,'mbx.a.m');`,
      resolveDir: app,
      loader: 'tsx',
    },
    absWorkingDir: app,
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    plugins: [
      {
        name: 'test-boundaries',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) =>
            Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'mock' } : undefined,
          );
          build.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
            contents: mocks[args.path],
            loader: 'tsx',
            resolveDir: app,
          }));
        },
      },
    ],
  });
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => route.abort());
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: build.outputFiles[0].text });
    await page.getByText('loaded', { exact: true }).waitFor();
    await page.evaluate(() => window.mountReaders(8, 'mbx.a.m'));
    await page.waitForFunction(() => document.querySelectorAll('span').length === 8);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
    assert.equal(
      await page.evaluate(() => window.reads),
      1,
      'mounting nested readers must reuse fresh data',
    );
    assert.equal(
      await page.evaluate(() => window.attachments),
      0,
      'IMAP attachments are already in the body',
    );
    await page.evaluate(() => window.mountReaders(1, 'mbx.a.fail', true));
    await page.getByText('failed', { exact: true }).waitFor();
    await page.evaluate(() => window.mountReaders(8, 'mbx.a.fail', true));
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
    assert.equal(
      await page.evaluate(() => window.reads),
      2,
      'non-transient errors must not retry on remount',
    );
    await page.evaluate(() => window.mountReaders(1, null, true));
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
    assert.equal(
      await page.evaluate(() => window.reads),
      2,
      'closed readers must not fetch the URL-selected message',
    );
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.evaluate(() => {
      Math.random = () => 0;
    });
    const mount = async (id, count = 8) => {
      await page.evaluate(({ id, count }) => window.mountReaders(count, id, true), { id, count });
      await page.clock.runFor(25);
    };
    const attempts = (id) => page.evaluate((id) => window.attempts[id] || [], id);
    const exhausted = 'mbx.a.backoff';
    await mount(exhausted);
    assert.equal((await attempts(exhausted)).length, 1);
    await page.clock.runFor(4900);
    assert.equal((await attempts(exhausted)).length, 1, 'no immediate retry');
    await page.clock.runFor(100);
    assert.equal((await attempts(exhausted)).length, 2);
    await page.clock.runFor(10000);
    assert.equal((await attempts(exhausted)).length, 3);
    await page.clock.runFor(20000);
    const times = await attempts(exhausted);
    assert.equal(times.length, 4, 'eight observers share initial request plus three retries');
    assert.deepEqual(
      times.slice(1).map((time, i) => time - times[i]),
      [5000, 10000, 20000],
    );
    await mount(exhausted);
    await page.clock.runFor(120000);
    assert.equal((await attempts(exhausted)).length, 4, 'exhausted remount must stay stopped');

    const recover = 'mbx.a.backoff-recover';
    await mount(recover);
    await page.clock.runFor(15100);
    assert.equal((await attempts(recover)).length, 3);
    assert.equal(await page.getByText('loaded', { exact: true }).count(), 8);
    await page.clock.runFor(30000);
    assert.equal((await attempts(recover)).length, 3, 'success ends retries');

    const minute = 'mbx.a.backoff-minute';
    await mount(minute);
    await page.clock.runFor(59000);
    assert.equal((await attempts(minute)).length, 1, 'Retry-After prevents early retry');
    await page.clock.runFor(1000);
    const minuteTimes = await attempts(minute);
    assert.equal(minuteTimes.length, 2);
    assert.equal(minuteTimes[1] - minuteTimes[0], 60000);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: shared reads, idle null readers, cached attachments, 5/10/20s backoff, retry cap, recovery, no retry on exhausted remount, and Retry-After. No network.',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
