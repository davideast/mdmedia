/** Run against an isolated sandbox with a published fixture and sandbox auth state. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const origin = process.env.ASSEMBLY_BROWSER_URL ?? 'http://127.0.0.1:3173';
const production = process.env.ASSEMBLY_PRODUCTION_ID;
const version = process.env.ASSEMBLY_VERSION_ID;
assert(production && version && process.env.ASSEMBLY_AUTH_STATE, 'Provide fixture IDs and sandbox storage state');
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Use an isolated local sandbox');
let watcher;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ storageState: process.env.ASSEMBLY_AUTH_STATE, viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await context.routeWebSocket('**/*', socket => {
    if (['127.0.0.1', 'localhost'].includes(new URL(socket.url()).hostname)) socket.connectToServer();
    else socket.close();
  });
  const page = await context.newPage();
  await page.goto(`${origin}/productions/${production}`);
  await page.getByRole('region', { name: 'Production draft' }).waitFor({ timeout: 60000 });
  assert.equal(await page.locator('video').count(), 0);
  await page.getByRole('button', { name: '02 Unfilled ending' }).click();
  await page.getByRole('region', { name: 'Assembly details' }).waitFor();
  assert.match(await page.getByRole('region', { name: 'Assembly details' }).innerText(), /Next steps/);
  await page.getByRole('button', { name: '01 Show the problem' }).click();
  assert.match(await page.getByRole('region', { name: 'Assembly details' }).innerText(), /Picture in picture/);
  console.log('PASS: scene media and timing open in existing right panel; untimed scenes need no player');
  await page.goto(`${origin}/productions/${production}/cuts/${version}`);
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, { timeout: 60000 });
  await page.waitForFunction(() => [...document.querySelectorAll('button[data-placement] img')].filter(i => i.complete && i.naturalWidth > 0).length >= 2, undefined, { timeout: 10000 });
  assert.equal(await page.getByRole('region', { name: 'Scenes' }).count(), 0);
  assert(await page.getByRole('group', { name: 'Timeline zoom' }).isVisible());
  await page.locator('video').evaluate(v => { v.muted = true; });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.2);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  assert.equal(await page.locator('video').evaluate(v => v.controls), false);
  await page.getByRole('button', { name: /^Picture in picture: pip,/ }).click();
  assert(Math.abs(await page.locator('video').evaluate(v => v.currentTime) - 1) < 0.1);
  assert.match(await page.getByRole('region', { name: 'Assembly details' }).innerText(), /Picture in picture/);
  const resize = page.getByRole('separator', { name: /preview/i });
  const before = await resize.getAttribute('aria-valuenow');
  await resize.focus(); await resize.press('ArrowDown');
  await page.waitForFunction(h => document.querySelector('[aria-label="Resize video preview"]')?.getAttribute('aria-valuenow') !== h, before);
  await page.getByRole('button', { name: 'Enter fullscreen preview' }).click();
  await page.getByRole('button', { name: 'Exit fullscreen preview' }).waitFor();
  await page.getByRole('button', { name: 'Exit fullscreen preview' }).click();
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.getByRole('button', { name: 'Enter fullscreen preview' }).waitFor();
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    const stage = v?.parentElement?.parentElement;
    return v && stage && v.getBoundingClientRect().width <= stage.getBoundingClientRect().width + 1;
  });
  console.log('PASS: published render plays; placement seeks; resize and fullscreen work');
  if (process.env.ASSEMBLY_TEST_TOKEN_FILE) {
    const token = await fs.readFile(process.env.ASSEMBLY_TEST_TOKEN_FILE, 'utf8');
    const events = [];
    const startWatch = () => {
      const child = spawn(process.env.BUN_EXECUTABLE ?? 'bun', ['src/bin.ts', 'comments', 'watch', production, '--cut', version], {
        env: { ...process.env, MDMEDIA_STUDIO_URL: origin, MDMEDIA_API_KEY: token }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let pending = '';
      child.stdout.on('data', data => {
        pending += data;
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (line) events.push(JSON.parse(line));
        }
      });
      return child;
    };
    const until = async predicate => {
      const deadline = Date.now() + 20000;
      while (!predicate()) {
        assert(Date.now() < deadline, 'CLI watch did not receive the browser review');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };
    watcher = startWatch();
    await until(() => events.some(e => e.event === 'snapshot'));
    const text = `Browser review ${Date.now()}`;
    await page.getByRole('button', { name: /^Comment/ }).click();
    await page.getByRole('textbox', { name: 'Comment', exact: true }).fill(text);
    await page.getByRole('form', { name: 'New comment' }).getByRole('button', { name: 'Comment', exact: true }).click();
    await until(() => events.some(e => e.threads?.some(t => t.text === text)));
    watcher.kill('SIGINT');
    events.length = 0;
    watcher = startWatch();
    await until(() => events.some(e => e.event === 'snapshot' && e.threads?.some(t => t.text === text)));
    watcher.kill('SIGINT'); watcher = null;
    console.log('PASS: real browser comment reaches CLI watch; reconnect restores current review state');
  }
  await page.screenshot({ path: '/tmp/assembly-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '/tmp/assembly-phone.png', fullPage: true });
  console.log('PASS: phone layout has no page overflow');
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (process.env.ASSEMBLY_LEGACY_ID) {
    await page.goto(`${origin}/productions/${process.env.ASSEMBLY_LEGACY_ID}/cuts/first`);
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
    assert.equal(await page.getByRole('region', { name: 'Assembly details' }).count(), 0);
    assert.equal(await page.getByText('Production details', { exact: true }).count(), 0);
    await page.locator('video').evaluate(async v => { v.muted = true; await v.play(); });
    await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.2);
    console.log('PASS: legacy rendered production still plays without an added inspector');
  }
  if (process.env.ASSEMBLY_STORYBOARD_ID) {
    await page.goto(`${origin}/storyboards/${process.env.ASSEMBLY_STORYBOARD_ID}?view=board`);
    await page.getByRole('button', { name: 'Create production', exact: true }).click();
    await page.waitForURL(/\/productions\/[^/]+$/);
    await page.getByRole('region', { name: 'Production draft' }).waitFor();
    assert.equal(await page.locator('video').count(), 0);
    assert.equal(await page.getByRole('region', { name: 'Assembly tracks' }).count(), 0);
    assert(await page.getByRole('button', { name: '02 Unfilled ending' }).isVisible());
    const first = page.url();
    await page.goto(`${origin}/storyboards/${process.env.ASSEMBLY_STORYBOARD_ID}?view=board`);
    await page.getByRole('button', { name: 'Create production', exact: true }).click();
    await page.waitForURL(/\/productions\/[^/]+$/);
    assert.notEqual(page.url(), first);
    console.log('PASS: storyboard right-panel action creates independent untimed productions');
  }

} finally { watcher?.kill('SIGINT'); await browser.close(); }
