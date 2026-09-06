// Exercises the real reader and AI panel with mocked transport/rendering boundaries.
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const esbuild = createRequire(require.resolve('tsx/package.json'))('esbuild');
const { chromium } = createRequire(resolve(__dirname, '../packages/testing/package.json'))(
  '@playwright/test',
);
const app = resolve(__dirname, '../apps/mail');
const mocks = {
  '@/providers/query-provider': `const trpc={ai:{translation:{queryOptions:(input,options)=>({queryKey:['translation',input],queryFn:async()=>{if(window.saved?.expiresAt<=Date.now())window.saved=null;return window.saved;},...options})}}};export const useTRPC=()=>trpc;export const useTRPCClient=()=>({ai:{read:{mutate:async()=>{window.calls++;window.saved={html:'<table width="600"><tbody><tr><td>你好</td></tr></tbody></table>',subject:'翻译主题',language:'zh-CN',expiresAt:Date.now()+5000};return {text:'',translation:window.saved};}}}});`,
  '@/hooks/use-llm': `export const useEnsureLlm=()=>async()=>true;`,
  '@/paraglide/runtime': `export const getLocale=()=> 'zh-CN';`,
  '@/paraglide/messages': `export const m=new Proxy({}, {get:(_,key)=>()=>key});`,
  '@/locales': `export const locales={'zh-CN':'简体中文'};`,
  './mail-content': `import React from 'react';export function MailContent({html}) {return <div data-testid="mail-content" dangerouslySetInnerHTML={{__html:html}}/>;}`,
  '../ui/button': `import React from 'react';export function Button({children,variant,size,...props}){return <button {...props}>{children}</button>;}`,
  '../ui/textarea': `import React from 'react';export function Textarea(props){return <textarea {...props}/>;}`,
};
(async () => {
  const build = await esbuild.build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {MailReader} from './components/mail/mail-reader';window.saved=null;window.calls=0;const cache=new QueryClient({defaultOptions:{queries:{retry:false}}});const root=createRoot(document.getElementById('root'));let epoch=0;window.reopen=()=>root.render(<QueryClientProvider client={cache}><MailReader key={epoch++} threadId="mbx.a.t" messageId="mbx.a.m" html="<table width='600'><tbody><tr><td>Hello</td></tr></tbody></table>" subject="Subject" senderEmail="sender@example.invalid" showAi={true}/></QueryClientProvider>);window.reopen();`,
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
    await page.clock.install();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: build.outputFiles[0].text });
    await page.getByText('Hello', { exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'mailAi.showTranslation', exact: true }).count(),
      0,
    );
    await page.getByRole('button', { name: 'mailAi.translate', exact: true }).click();
    await page.getByRole('button', { name: 'mailAi.translate', exact: true }).last().click();
    await page.getByText('你好', { exact: true }).waitFor();
    const original = page.getByRole('button', { name: 'mailAi.showOriginal', exact: true });
    assert.equal(await original.innerText(), '', 'toggle is icon-only');
    await original.click();
    await page.getByText('Hello', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'mailAi.showTranslation', exact: true }).click();
    await page.getByText('你好', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.calls), 1, 'toggle uses cached translation');
    await page.evaluate(() => window.reopen());
    await page.getByRole('button', { name: 'mailAi.showTranslation', exact: true }).waitFor();
    await page.getByRole('button', { name: 'mailAi.showTranslation', exact: true }).click();
    await page.getByText('你好', { exact: true }).waitFor();
    await page.clock.fastForward(6000);
    await page.getByText('Hello', { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole('button', { name: /mailAi.showOriginal|mailAi.showTranslation/ })
        .count(),
      0,
    );
    assert.equal(await page.evaluate(() => window.saved), null, 'expired cache is removed');
    assert.equal(
      await page.evaluate(() => window.calls),
      1,
      'expiry does not automatically call AI',
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS: HTML translation panel, icon-only toggle, cached switching, reopening, timed expiry and return to original. Transport mocked; no network requests.',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
