/** Run against local sandbox Studio. Intercepts storyboard HTTP only; no saved user records or media jobs. */
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const origin = process.env.STORYBOARD_BROWSER_URL ?? 'http://127.0.0.1:3171';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const beat = id => ({ id, title: `Beat ${id}`, purpose: '', script: 'Original words', visual: '', notes: '', status: 'draft', estimatedSeconds: null });
const saved = { id: 'browser-review', title: 'Editor regression', createdAt: 1, updatedAt: 1, storyboard: { revision: 1, updatedAt: 1, document: { version: 1, premise: '', beats: [beat('first')] } } };
try {
 const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
 page.on('dialog', d => d.accept());
 await page.route('**/api/v1/storyboards**', async route => {
  const url = new URL(route.request().url());
  assert.equal(route.request().method(), 'GET', 'Browser proof must never write to the backend');
  await route.fulfill({ json: url.pathname === '/api/v1/storyboards' ? { storyboards: [{ id: saved.id, title: saved.title, updatedAt: 1, beatCount: saved.storyboard.document.beats.length, image: null }] } : saved });
 });
 await page.goto(`${origin}/storyboards/${saved.id}?view=script&beat=first`);
 const login = page.getByRole('button', { name: 'Continue with Google' });
 await Promise.race([login.waitFor({timeout:60000}),page.getByRole('list',{name:'Script',exact:true}).waitFor({timeout:60000})]);
 if (await login.isVisible().catch(() => false)) { await login.click(); await page.getByRole('button', { name: 'David East — dceast@gmail.com', exact: true }).click(); }
 const script = page.getByRole('textbox', { name: 'script', exact: true });
 await script.waitFor({timeout:60000});
 const revisit = async () => {
  await page.getByRole('link', { name: 'Storyboards', exact: true }).first().click();
  await page.getByRole('button', {name:'New storyboard',exact:true}).waitFor();
  await page.getByRole('link', { name: /^Editor regression 1 beat$/ }).click();
  await page.getByRole('button', { name: /Edit beat 1:/ }).click();
  await script.waitFor();
 };
 await script.fill('An edit that will be undone');
 await page.getByRole('button',{name:'Undo',exact:true}).click();
 saved.storyboard.revision = 2; saved.storyboard.document.beats[0].script = 'Updated by CLI';
 await revisit();
 await page.waitForFunction(() => document.querySelector('[aria-label="script"]')?.value === 'Updated by CLI');
 await revisit();
 assert.equal(await script.inputValue(),'Updated by CLI');
 console.log('PASS: clean editor adopts refreshed CLI revision without resurrecting an undone draft');
 await script.fill('My unsaved words');
 saved.storyboard.revision = 3; saved.storyboard.document.beats[0].script = 'Another client';
 await revisit();
 assert.equal(await script.inputValue(), 'My unsaved words');
 console.log('PASS: refresh preserves dirty edits');
 // Reload a separate 100-beat board to check limits without depending on undo history.
 saved.id = 'browser-limits';
 saved.storyboard.document.beats = Array.from({length:100}, (_, i) => beat(i === 0 ? 'first' : `b${i}`));
 await page.goto(`${origin}/storyboards/${saved.id}?view=script&beat=first`); await script.waitFor();
 assert.equal(await page.getByRole('button', {name:'Add beat',exact:true}).isDisabled(), true);
 // Fill 21 scripts to exceed the 160 KB API limit while remaining valid individual fields.
 for(let i=0;i<21;i++) {
  await page.getByRole('button', {name:new RegExp(`^Edit beat ${i+1}:`)}).click();
  await script.fill('x'.repeat(8000));
 }
 await page.getByRole('button', {name:/^Edit beat 1:/}).click();
 await page.reload(); await script.waitFor();
 assert.equal((await script.inputValue()).length,8000);
 await page.getByRole('button',{name:/^Edit beat 21:/}).click();
 assert.equal((await script.inputValue()).length,8000);
 console.log('PASS: oversized unsaved draft survives reload');
 await page.setViewportSize({width:390,height:844});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 console.log('PASS: phone width has no horizontal overflow');
} finally { await browser.close(); }
