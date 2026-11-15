import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function createNetwork(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a network', exact: true }).click();
  await page.getByLabel('Network name').fill('Organized notebook');
  await page.getByRole('button', { name: 'Create network', exact: true }).click();
}

async function addTag(page: Page, tag: string, normalized = tag) {
  const dialog = page.getByRole('dialog', { name: 'Edit tags', exact: true });
  await dialog.getByLabel('Tag name', { exact: true }).fill(tag);
  await dialog.getByRole('button', { name: 'Add tag', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Remove tag ' + normalized, exact: true })).toBeVisible();
}

async function closeDialog(page: Page) {
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
}

async function createNote(page: Page, title: string, body: string, tags: string | string[]) {
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  await page.getByLabel('Note title', { exact: true }).fill(title);
  await page.getByLabel('Note text', { exact: true }).fill(body);
  await page.getByRole('button', { name: 'Edit note tags', exact: true }).click();
  for (const tag of typeof tags === 'string' ? [tags] : tags) await addTag(page, tag);
  await closeDialog(page);
  await expect(page.getByLabel('Note text', { exact: true })).toHaveValue(body);
}

async function selectTagFilter(page: Page, kind: 'notes' | 'files', tag: string, checked = true) {
  await page.getByRole('button', { name: 'Filter ' + kind + ' by tag', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Filter ' + kind + ' by tag', exact: true });
  const choice = dialog.getByRole('checkbox', { name: tag, exact: true });
  if (await choice.getAttribute('aria-checked') !== (checked ? 'true' : 'false')) await choice.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

test('note search matches the whole title and body and combines with tag filtering', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await createNetwork(page);
  const longBody = 'Ordinary recording notes.\n'.repeat(30) + 'Record the saxophone after midnight.';
  await createNote(page, 'Café session', longBody, ['studio', 'ready']);
  await createNote(page, 'Field recordings', 'The café terrace has a saxophone player.', ['outside', 'ready']);
  await createNote(page, 'Piano practice', 'Try the minor progression after midnight.', 'studio');
  const notes = page.locator('[data-note]');
  const search = page.getByRole('searchbox', { name: 'Search notes', exact: true });
  const filter = page.getByRole('button', { name: 'Filter notes by tag', exact: true });

  await search.fill('CAFE SAXOPHONE');
  await expect(notes).toHaveCount(2);
  await expect(notes.filter({ hasText: 'Café session' })).toBeVisible();
  await expect(notes.filter({ hasText: 'Field recordings' })).toBeVisible();
  await selectTagFilter(page, 'notes', 'studio');
  await expect(notes).toHaveCount(1);
  await expect(notes).toContainText('Café session');
  await selectTagFilter(page, 'notes', 'ready');
  await expect(filter).toHaveText('studio, ready');
  await expect(notes).toHaveCount(1);
  await search.fill('piano midnight');
  await expect(notes).toHaveCount(0);
  await filter.click();
  const choices = page.getByRole('dialog', { name: 'Filter notes by tag', exact: true });
  await expect(choices.getByRole('checkbox', { name: 'studio', exact: true })).toBeChecked();
  const ready = choices.getByRole('checkbox', { name: 'ready', exact: true });
  await expect(ready).toBeChecked();
  await ready.focus();
  await page.keyboard.press('Space');
  await expect(ready).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(filter).toBeFocused();
  await expect(notes).toHaveCount(1);
  await expect(notes).toContainText('Piano practice');

  await search.fill('a-word-that-is-not-present');
  await expect(notes).toHaveCount(0);
  await expect(page.locator('#note-list')).toContainText('No');
  await search.fill('');
  await expect(notes).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear note filters', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(filter).toHaveText('All tags');
  await expect(notes).toHaveCount(3);
  await notes.filter({ hasText: 'Café session' }).click();
  await expect(page.getByLabel('Note text', { exact: true })).toHaveValue(longBody);
});

test('tag edits normalize duplicates and preserve the latest note text', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await createNetwork(page);
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  await page.getByLabel('Note title', { exact: true }).fill('Latest take');
  const body = '# Unfinished session\n\nKeep this **newly typed** text intact.\n\n```ts\nconst dud = 54\n```';
  await page.getByLabel('Note text', { exact: true }).fill(body);
  // Open immediately after typing; tag editing must coordinate with autosave.
  await page.getByRole('button', { name: 'Edit note tags', exact: true }).click();
  await addTag(page, '  Studio   Sessions  ', 'studio sessions');
  await addTag(page, 'STUDIO SESSIONS', 'studio sessions');
  const dialog = page.getByRole('dialog', { name: 'Edit tags', exact: true });
  await expect(dialog.getByRole('button', { name: 'Remove tag studio sessions', exact: true })).toHaveCount(1);
  await closeDialog(page);
  await expect(page.getByLabel('Note text', { exact: true })).toHaveValue(body);
  await expect(page.locator('[data-note]')).toContainText('studio sessions');
  await expect(page.locator('#save-state')).toContainText('Saved for this session');
  await expect(page.getByRole('region', { name: 'Markdown preview' }).locator('pre code')).toHaveText('const dud = 54\n');
  await page.getByRole('region', { name: 'Markdown preview' }).click();

  await page.getByRole('button', { name: 'Edit note tags', exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove tag studio sessions', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Remove tag studio sessions', exact: true })).toHaveCount(0);
  await closeDialog(page);
  await expect(page.locator('[data-note]')).not.toContainText('studio sessions');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.locator('[data-note]').click();
  await expect(page.getByLabel('Note text', { exact: true })).toHaveValue(body);
});

test('file tags filter independently of notes and preserve preview and export', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await createNetwork(page);
  await createNote(page, 'Mix instructions', 'Use the second take.', 'studio');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const content = '# Recording plan\n\nKeep the second take.';
  await page.getByLabel('Choose files').setInputFiles([
    { name: 'Plan.md', mimeType: 'text/markdown', buffer: Buffer.from(content) },
    { name: 'Shopping.txt', mimeType: 'text/plain', buffer: Buffer.from('Coffee and tea') },
    { name: 'Draft.txt', mimeType: 'text/plain', buffer: Buffer.from('An unfinished studio plan') },
  ]);
  await page.getByRole('button', { name: 'Edit tags for Plan.md', exact: true }).click();
  await addTag(page, 'studio');
  await addTag(page, 'ready');
  await closeDialog(page);
  await expect(page.getByRole('button', { name: 'Edit tags for Plan.md', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Edit tags for Shopping.txt', exact: true }).click();
  await addTag(page, 'errands');
  await addTag(page, 'ready');
  await closeDialog(page);
  await page.getByRole('button', { name: 'Edit tags for Draft.txt', exact: true }).click();
  await addTag(page, 'studio');
  await closeDialog(page);

  const files = page.locator('.file-card');
  const filter = page.getByRole('button', { name: 'Filter files by tag', exact: true });
  await selectTagFilter(page, 'files', 'studio');
  await expect(files).toHaveCount(2);
  await selectTagFilter(page, 'files', 'ready');
  await expect(filter).toHaveText('studio, ready');
  await expect(files).toHaveCount(1);
  await expect(files).toContainText('Plan.md');
  await page.getByRole('button', { name: 'View Plan.md', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Recording plan', exact: true })).toBeVisible();
  const downloadPending = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Save file', exact: true }).click();
  expect((await downloadPending).suggestedFilename()).toBe('Plan.md');
  await closeDialog(page);

  await page.getByRole('button', { name: 'Edit tags for Plan.md', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove tag studio', exact: true }).click();
  await closeDialog(page);
  await expect(files).toHaveCount(0);
  await expect(filter).toBeFocused();
  await page.getByRole('button', { name: 'Clear file filters', exact: true }).click();
  await expect(filter).toHaveText('All tags');
  await expect(files).toHaveCount(3);
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await selectTagFilter(page, 'notes', 'studio');
  await expect(page.locator('[data-note]')).toHaveCount(1);
  await expect(page.locator('[data-note]')).toContainText('Mix instructions');
});

test('tag dialogs, filters and search stay usable on a narrow phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await createNetwork(page);
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  await page.getByLabel('Note title', { exact: true }).fill('Phone note');
  await page.getByLabel('Note text', { exact: true }).fill('Searchable words on a small screen.');
  await page.getByRole('button', { name: 'Edit note tags', exact: true }).click();
  await addTag(page, 'a very long but valid tag name');
  const dialog = page.getByRole('dialog', { name: 'Edit tags', exact: true });
  const bounds = await dialog.boundingBox();
  if (bounds === null) throw new Error('Missing tag editor');
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(568);
  await page.screenshot({ path: testInfo.outputPath('tags-phone-dialog.png') });
  await closeDialog(page);
  await page.getByRole('button', { name: 'Notes', exact: true }).first().click();
  await page.getByRole('searchbox', { name: 'Search notes', exact: true }).fill('small screen');
  await selectTagFilter(page, 'notes', 'a very long but valid tag name');
  await expect(page.locator('[data-note]')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('tags-phone-filter.png') });
});

test('an active search and tag options refresh when a peer changes a note', async ({ page }) => {
  await page.addInitScript(() => {
    const snapshot = {
      network: { id: 'organized-network', name: 'Shared notebook', invite: 'murmur://join#test', phrase: 'abandon '.repeat(23) + 'art' },
      notes: [{ id: 'peer-note', title: 'Field memo', body: 'Waiting for an update.', tags: ['draft'], updatedAt: 1 }],
      files: [], heads: ['original'], status: { peers: 0, lastSync: null, error: null }, deviceId: 'device', listenerPort: 0,
    };
    window.addEventListener('test-organized-peer-update', () => {
      const note = snapshot.notes[0];
      if (note === undefined) throw new Error('Missing peer note');
      note.body = 'The hidden saxophone recording arrived.';
      note.tags = ['ready'];
      snapshot.heads = ['peer-update'];
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
        return null;
      },
    } });
  });
  await page.goto('/');
  const search = page.getByRole('searchbox', { name: 'Search notes', exact: true });
  await search.fill('saxophone');
  await expect(page.locator('[data-note]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Filter notes by tag', exact: true }).click();
  const choices = page.getByRole('dialog', { name: 'Filter notes by tag', exact: true });
  const draftTag = choices.getByRole('checkbox', { name: 'draft', exact: true });
  await draftTag.click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-organized-peer-update')));
  const ready = choices.getByRole('checkbox', { name: 'ready', exact: true });
  await expect(ready).toBeVisible({ timeout: 6000 });
  await expect(draftTag).toBeChecked();
  await expect(draftTag).toBeFocused();
  await ready.click();
  await expect(page.locator('[data-note]')).toHaveCount(0);
  await draftTag.click();
  await expect(draftTag).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-note]')).toHaveCount(1);
  await expect(search).toHaveValue('saxophone');
  await expect(page.locator('[data-note]')).toContainText('ready');
});

test('existing tags can be reused from themed suggestions without a native dropdown', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await createNetwork(page);
  await createNote(page, 'Original session', 'First recording.', ['studio', 'outside']);
  await createNote(page, 'New session', 'Second recording.', []);
  await page.getByRole('button', { name: 'Edit note tags', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit tags', exact: true });
  const suggestions = dialog.getByRole('group', { name: 'Suggested tags', exact: true });
  await expect(dialog.locator('datalist, input[list]')).toHaveCount(0);
  await expect(suggestions.getByRole('button', { name: 'Add tag outside', exact: true })).toBeVisible();
  const name = dialog.getByLabel('Tag name', { exact: true });
  await name.fill('STU');
  const studio = suggestions.getByRole('button', { name: 'Add tag studio', exact: true });
  await expect(studio).toBeVisible();
  await expect(suggestions.getByRole('button', { name: 'Add tag outside', exact: true })).toHaveCount(0);
  await studio.click();
  await expect(dialog.getByRole('button', { name: 'Remove tag studio', exact: true })).toBeVisible();
  await expect(studio).toHaveCount(0);
  await closeDialog(page);
  await expect(page.locator('#note-tag-summary')).toContainText('studio');
  await expect(page.getByLabel('Note text', { exact: true })).toHaveValue('Second recording.');
});

test('the tag picker anchors to its filter, keeps multiple choices open, and dismisses outside', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await createNetwork(page);
  await createNote(page, 'Studio take', 'Ready to mix.', ['studio', 'ready']);
  await createNote(page, 'Field take', 'Ambient sounds.', 'outside');
  const filter = page.getByRole('button', { name: 'Filter notes by tag', exact: true });
  const trigger = await filter.boundingBox();
  if (trigger === null) throw new Error('Missing tag filter');
  await filter.click();
  const picker = page.getByRole('dialog', { name: 'Filter notes by tag', exact: true });
  await expect(picker).toBeVisible();
  await expect(picker.locator('select, input[type="checkbox"]')).toHaveCount(0);
  await expect(picker.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0);
  const bounds = await picker.boundingBox();
  if (bounds === null) throw new Error('Missing tag picker');
  expect(Math.abs(bounds.x - trigger.x)).toBeLessThanOrEqual(2);
  expect(bounds.y).toBeGreaterThanOrEqual(trigger.y + trigger.height);
  expect(bounds.y - trigger.y - trigger.height).toBeLessThanOrEqual(12);
  await picker.getByRole('checkbox', { name: 'outside', exact: true }).focus();
  await page.keyboard.press('End');
  await expect(picker.getByRole('checkbox', { name: 'studio', exact: true })).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('Home');
  await expect(picker.getByRole('checkbox', { name: 'outside', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(picker.getByRole('checkbox', { name: 'ready', exact: true })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('checkbox', { name: 'studio', exact: true })).toBeChecked();
  await expect(picker.getByRole('checkbox', { name: 'ready', exact: true })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('tag-picker-dark-desktop.png') });
  const search = page.getByRole('searchbox', { name: 'Search notes', exact: true });
  await search.click();
  await expect(picker).toHaveCount(0);
  await expect(search).toBeFocused();
  await expect(filter).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-note]')).toHaveCount(1);
  await filter.click();
  await picker.getByRole('button', { name: 'Clear tags', exact: true }).click();
  await expect(picker.getByRole('checkbox', { name: 'studio', exact: true })).not.toBeChecked();
  await expect(picker.getByRole('checkbox', { name: 'ready', exact: true })).not.toBeChecked();
  await filter.click();
  await expect(picker).toHaveCount(0);
  await expect(page.locator('[data-note]')).toHaveCount(2);
});

test('delayed picker autofocus cannot replace a tag the user already focused', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-15T12:00:00Z') });
  await page.setViewportSize({ width: 1100, height: 760 });
  await createNetwork(page);
  await createNote(page, 'Keyboard selection', 'Keep the selected tag.', ['outside', 'ready', 'studio']);
  await page.clock.pauseAt(new Date('2026-11-15T13:00:00Z'));
  await page.getByRole('button', { name: 'Filter notes by tag', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Filter notes by tag', exact: true });
  const ready = picker.getByRole('checkbox', { name: 'ready', exact: true });
  await ready.focus();
  // Run the opening timer after the user has deliberately moved to another tag.
  await page.clock.runFor(100);
  await expect(ready).toBeFocused();
  await page.keyboard.press('Space');
  await expect(ready).toBeChecked();
  await expect(picker.getByRole('checkbox', { name: 'outside', exact: true })).not.toBeChecked();
});

test('the tag picker stays within a narrow phone and short landscape viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await createNetwork(page);
  await createNote(page, 'Many tags', 'Keep these organized.', ['a very long but valid tag name', 'studio', 'ready', 'outside', 'recordings', 'ideas']);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByRole('button', { name: 'Notes', exact: true }).first().click();
  for (const viewport of [{ width: 320, height: 568 }, { width: 700, height: 260 }, { width: 700, height: 150 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: 'Filter notes by tag', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Filter notes by tag', exact: true });
    const bounds = await picker.boundingBox();
    if (bounds === null) throw new Error('Missing tag picker');
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    expect(await picker.locator('.tag-filter-choices').evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(44);
    const last = picker.getByRole('checkbox', { name: 'studio', exact: true });
    await last.click();
    await expect(last).toBeChecked();
    await last.press('Space');
    await expect(last).not.toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('tag-picker-' + viewport.width.toString() + 'x' + viewport.height.toString() + '.png') });
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
  }
});

test('native tag failures keep the dialog retryable and never claim an unsaved tag', async ({ page }) => {
  await page.addInitScript(() => {
    const snapshot = {
      network: { id: 'tag-network', name: 'Shared notebook', invite: 'murmur://join#test', phrase: 'abandon '.repeat(23) + 'art' },
      notes: [{ id: 'tag-note', title: 'Stored session', body: 'This text is already saved.', tags: ['original'], updatedAt: 1 }],
      files: [], heads: ['original'], status: { peers: 0, lastSync: null, error: null }, deviceId: 'device', listenerPort: 0,
    };
    let failTag = true;
    Object.defineProperty(window, 'isTauri', { value: true });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {
      transformCallback: () => 1,
      invoke: (command: string, args: unknown): unknown => {
        if (command === 'bootstrap' || command === 'get_snapshot' || command === 'sync_now') return structuredClone(snapshot);
        if (command === 'get_pending_shares') return [];
        if (command === 'get_settings') return { theme: 'system' };
        if (command === 'plugin:lan|is_mobile') return false;
        if (command === 'plugin:event|listen') return 1;
        if (command === 'set_tag') {
          if (typeof args !== 'object' || args === null || !('networkId' in args) || args.networkId !== 'tag-network' || !('kind' in args) || args.kind !== 'note' || !('id' in args) || args.id !== 'tag-note' || !('tag' in args) || args.tag !== 'studio' || !('present' in args) || args.present !== true) throw new Error('Invalid tag request');
          if (failTag) { failTag = false; throw new Error('Temporary tag save failure.'); }
          const note = snapshot.notes[0];
          if (note === undefined) throw new Error('Missing note');
          note.tags.push(args.tag);
          snapshot.heads = ['tag-saved'];
          return structuredClone(snapshot);
        }
        return null;
      },
    } });
  });
  await page.goto('/');
  await page.locator('[data-note]').click();
  await page.getByRole('button', { name: 'Edit note tags', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit tags', exact: true });
  await dialog.getByLabel('Tag name', { exact: true }).fill('Studio');
  await dialog.getByRole('button', { name: 'Add tag', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Temporary tag save failure.');
  await expect(dialog.getByRole('button', { name: 'Remove tag studio', exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Tag name', { exact: true })).toHaveValue('Studio');
  await dialog.getByRole('button', { name: 'Add tag', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Remove tag studio', exact: true })).toBeVisible();
  await closeDialog(page);
  await expect(page.getByLabel('Note text', { exact: true })).toHaveValue('This text is already saved.');
});

test('network status and management live in Settings instead of the note and file lists', async ({ page }) => {
  await createNetwork(page);
  const sync = page.getByRole('button', { name: 'Retry synchronization', exact: true });
  const manage = page.getByRole('button', { name: 'Manage network', exact: true });
  await expect(sync).toHaveCount(0);
  await expect(manage).toHaveCount(0);
  await expect(page.locator('.sidebar-bottom')).toHaveCount(0);
  await expect(page.locator('.network-pill')).toHaveCount(0);
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(sync).toHaveCount(0);
  await expect(manage).toHaveCount(0);
  await expect(page.locator('.files-footer')).toHaveCount(0);
  await expect(page.locator('.network-pill')).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(sync).toBeVisible();
  await expect(manage).toBeVisible();
  await manage.click();
  await expect(page.getByRole('dialog', { name: 'Manage network', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Invite a device', exact: true }).click();
  const invitation = page.getByRole('dialog', { name: 'Invite a device', exact: true });
  await expect(invitation.getByRole('img', { name: 'QR invitation for Organized notebook', exact: true })).toBeVisible();
  await expect(invitation.locator('.phrase-grid li')).toHaveCount(24);
});
