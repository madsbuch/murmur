import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Snapshot } from '../src/types';

async function newNote(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a network', exact: true }).click();
  await page.getByLabel('Network name').fill('Markdown notebook');
  await page.getByRole('button', { name: 'Create network', exact: true }).click();
  await page.getByRole('button', { name: 'New note', exact: true }).click();
}

const source = '# Track notes\n\n**Bold** and *soft*, ~~old~~ and `code`.\n\n- [x] Recorded\n- [ ] Mix\n\n1. Verse\n2. Chorus\n\n> Keep this take.\n\n```ts\nconst take = "one";\n```\n\n| Track | BPM |\n| --- | --- |\n| Intro | 120 |';

test('notes render Markdown on blur and preserve their editable source across views', async ({ page }, testInfo) => {
  await newNote(page);
  await page.getByLabel('Note title').fill('Session notes');
  await page.getByLabel('Note text').fill(source);
  await page.locator('.editor-bottom').click();
  const preview = page.getByRole('region', { name: 'Markdown preview' });
  await expect(preview.getByRole('heading', { name: 'Track notes' })).toBeVisible();
  await expect(preview.locator('strong')).toHaveText('Bold');
  await expect(preview.locator('em')).toHaveText('soft');
  await expect(preview.locator('del')).toHaveText('old');
  await expect(preview.locator('blockquote')).toHaveText('Keep this take.');
  await expect(preview.locator('pre code')).toHaveText('const take = "one";\n');
  await expect(preview.getByRole('checkbox').first()).toBeChecked();
  await expect(preview.getByRole('checkbox').first()).toBeDisabled();
  await expect(preview.getByRole('table')).toContainText('Intro');
  await expect(page.getByLabel('Note text')).toBeHidden();
  await expect(page.getByRole('button', { name: /^(Write|Preview)$/ })).toHaveCount(0);
  await expect(page.getByPlaceholder(/Markdown supported/)).toHaveCount(0);
  for (const width of [320, 768, 1100]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(preview).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const box = await preview.boundingBox();
    expect(box?.height).toBeGreaterThan(150);
    await page.screenshot({ path: testInfo.outputPath('markdown-' + width.toString() + '.png') });
  }
  await preview.getByRole('heading', { name: 'Track notes' }).click();
  await expect(page.getByLabel('Note text')).toBeFocused();
  await expect(page.getByLabel('Note text')).toHaveValue(source);
  await expect(page.locator('#save-state')).toContainText('Saved for this session');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.locator('[data-note]').click();
  await expect(preview.getByRole('heading', { name: 'Track notes' })).toBeVisible();
  await expect(page.getByLabel('Note text')).toBeHidden();
  await preview.click();
  await expect(page.getByLabel('Note text')).toHaveValue(source);
});

test('title and body focus keep source editable, and keyboard navigation renders and reopens it', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await newNote(page);
  const title = page.getByLabel('Note title');
  const body = page.getByLabel('Note text');
  const preview = page.getByRole('region', { name: 'Markdown preview' });
  await expect(title).toBeFocused();
  await expect(body).toBeVisible();
  await body.fill('# Keyboard note\n\nKeep **editing**.');
  await title.click();
  await expect(body).toBeVisible();
  await expect(preview).toBeHidden();
  await title.press('Tab');
  await expect(body).toBeFocused();
  await body.press('Tab');
  await expect(preview.getByRole('heading', { name: 'Keyboard note' })).toBeVisible();
  await expect(body).toBeHidden();
  await page.keyboard.press('Shift+Tab');
  await expect(body).toBeFocused();
  await expect(body).toHaveValue('# Keyboard note\n\nKeep **editing**.');
});

test('an empty note has no preview instructions and can be clicked to start writing', async ({ page }) => {
  await newNote(page);
  await page.locator('.editor-bottom').click();
  const preview = page.getByRole('region', { name: 'Markdown preview' });
  await expect(preview).toBeVisible();
  await expect(preview).toHaveText('');
  await preview.click();
  await expect(page.getByLabel('Note text')).toBeFocused();
  await page.getByLabel('Note text').fill('First line');
  await page.locator('.editor-bottom').click();
  await expect(preview).toHaveText('First line');
});

test('Markdown treats HTML as text, blocks active links and never fetches embedded images', async ({ page }) => {
  const fetched: string[] = [];
  await page.route('https://example.invalid/**', async route => { fetched.push(route.request().url()); await route.abort(); });
  await newNote(page);
  await page.getByLabel('Note text').fill('<script>window.markdownExecuted = true</script>\n\n<img src="https://example.invalid/raw.png" onerror="window.markdownExecuted=true">\n\n<button data-action="delete-note">Delete</button>\n\n[Bad](javascript:alert%281%29) [IPC](ipc://command) [Local](/settings) [Safe](https://example.invalid/docs)\n\n![Remote art](https://example.invalid/image.png)');
  await page.locator('.editor-bottom').click();
  const preview = page.getByRole('region', { name: 'Markdown preview' });
  await expect(preview.locator('script, img, button, iframe, [data-action]')).toHaveCount(0);
  await expect(preview.getByRole('link')).toHaveCount(1);
  await expect(preview.getByRole('link', { name: 'Safe' })).toHaveAttribute('target', '_blank');
  await expect(preview.getByRole('link', { name: 'Safe' })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(preview).toContainText('[Image: Remote art]');
  expect(fetched).toEqual([]);
  expect(await page.evaluate(() => { const executed: unknown = Reflect.get(window, 'markdownExecuted'); return executed; })).toBeUndefined();
});

test('links in a rendered note open without switching to source editing', async ({ page, context }) => {
  await context.route('https://example.invalid/**', async route => { await route.fulfill({ body: 'Documentation', contentType: 'text/html' }); });
  await newNote(page);
  await page.getByLabel('Note text').fill('# References\n\n[Documentation](https://example.invalid/docs)');
  await page.locator('.editor-bottom').click();
  const preview = page.getByRole('region', { name: 'Markdown preview' });
  const popupPending = page.waitForEvent('popup');
  await preview.getByRole('link', { name: 'Documentation' }).click();
  const popup = await popupPending;
  await expect(popup).toHaveURL('https://example.invalid/docs');
  await expect(preview.getByRole('heading', { name: 'References' })).toBeVisible();
  await expect(page.getByLabel('Note text')).toBeHidden();
  await popup.close();
});

async function nativeNote(page: Page, failSave = false) {
  const snapshot: Snapshot = {
    network: { id: 'markdown-network', name: 'Markdown', invite: 'murmur://join#test', phrase: 'abandon '.repeat(23) + 'art' },
    notes: [{ id: 'note', title: 'Peer note', body: '# Original\n\nA saved note.', updatedAt: 1, tags: [] }],
    files: [], heads: ['original'], status: { peers: 0, lastSync: null, error: null }, deviceId: 'device', listenerPort: 0,
  };
  await page.addInitScript(config => {
    const snapshot = config.snapshot;
    window.addEventListener('test-markdown-peer-edit', () => {
      const note = snapshot.notes[0];
      if (note !== undefined) note.body = '# From another device\n\n**Synchronized** content.';
      snapshot.heads = ['peer-edit'];
    });
    Object.defineProperty(window, 'isTauri', { value: true });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {
      transformCallback: () => 1,
      invoke: (command: string): unknown => {
        if (command === 'bootstrap' || command === 'get_snapshot' || command === 'sync_now') return structuredClone(snapshot);
        if (command === 'get_pending_shares') return [];
        if (command === 'get_settings') return { theme: 'system' };
        if (command === 'plugin:lan|is_mobile') return false;
        if (command === 'plugin:event|listen') return 1;
        if (command === 'update_note' && config.failSave) throw new Error('Test write failure');
        return null;
      },
    } });
  }, { snapshot, failSave });
  await page.goto('/');
  await page.locator('[data-note]').click();
}

test('an open Markdown preview reflects peer updates and retains the new source', async ({ page }) => {
  await nativeNote(page);
  const preview = page.getByRole('region', { name: 'Markdown preview' });
  await expect(preview.getByRole('heading', { name: 'Original' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('test-markdown-peer-edit')));
  await expect(preview.getByRole('heading', { name: 'From another device' })).toBeVisible({ timeout: 6000 });
  await expect(preview.locator('strong')).toHaveText('Synchronized');
  await preview.click();
  await expect(page.getByLabel('Note text')).toHaveValue('# From another device\n\n**Synchronized** content.');
});

test('a failed save does not prevent previewing or lose the unsaved Markdown source', async ({ page }) => {
  await nativeNote(page, true);
  await page.getByRole('region', { name: 'Markdown preview' }).click();
  await page.getByLabel('Note text').fill('# Still here\n\nMy **unsaved** draft.');
  await expect(page.locator('#save-state')).toHaveText('Not saved · tap to retry');
  await page.locator('.editor-bottom').click();
  await expect(page.getByRole('region', { name: 'Markdown preview' }).getByRole('heading', { name: 'Still here' })).toBeVisible();
  await expect(page.locator('#save-state')).toHaveText('Not saved · tap to retry');
  await page.getByRole('region', { name: 'Markdown preview' }).click();
  await expect(page.getByLabel('Note text')).toHaveValue('# Still here\n\nMy **unsaved** draft.');
});
