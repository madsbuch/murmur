import { expect, test } from '@playwright/test';
import { parseSnapshot } from '../src/validation';

test('a delayed tag reply cannot overwrite a newer note save after its dialog closes', async ({ page }) => {
  await page.addInitScript(() => {
    const snapshot = {
      network: { id: 'tag-network', name: 'Shared notebook', invite: 'murmur://join#test', phrase: 'abandon '.repeat(23) + 'art' },
      notes: [{ id: 'tag-note', title: 'Original title', body: 'Original saved text.', tags: ['original'], updatedAt: 1 }],
      files: [], heads: ['original'], status: { peers: 0, lastSync: null, error: null }, deviceId: 'device', listenerPort: 0,
    };
    Object.defineProperty(window, 'isTauri', { value: true });
    Object.defineProperty(window, '__TAG_RACE_SNAPSHOT__', { get: () => structuredClone(snapshot) });
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
          const note = snapshot.notes[0];
          if (note === undefined) throw new Error('Missing note');
          note.tags.push('studio');
          snapshot.heads = ['tag-committed'];
          // The command has committed, but its older snapshot arrives after a
          // subsequent note save. Delay delivery rather than the mutation.
          const reply = structuredClone(snapshot);
          document.documentElement.dataset['tagPending'] = 'true';
          return new Promise<typeof snapshot>(resolve => window.addEventListener('test-release-tag-reply', () => {
            delete document.documentElement.dataset['tagPending'];
            resolve(reply);
          }, { once: true }));
        }
        if (command === 'update_note') {
          if (typeof args !== 'object' || args === null || !('id' in args) || args.id !== 'tag-note' || !('title' in args) || typeof args.title !== 'string' || !('body' in args) || typeof args.body !== 'string') throw new Error('Invalid note request');
          const note = snapshot.notes[0];
          if (note === undefined) throw new Error('Missing note');
          note.title = args.title;
          note.body = args.body;
          snapshot.heads = ['newer-note-save'];
          return structuredClone(snapshot);
        }
        return null;
      },
    } });
  });
  await page.goto('/');
  await page.locator('[data-note]').click();
  await page.getByRole('button', { name: 'Edit note tags', exact: true }).click();
  await page.getByLabel('Tag name', { exact: true }).fill('studio');
  await page.getByRole('button', { name: 'Add tag', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-tag-pending', 'true');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByLabel('Note title', { exact: true }).fill('A newer title');
  await page.getByLabel('Note text', { exact: true }).fill('Newer text saved while the tag response was pending.');
  await expect(page.locator('#save-state')).toContainText('Saved on device');
  const saved: unknown = await page.evaluate(() => {
    const value: unknown = Reflect.get(window, '__TAG_RACE_SNAPSHOT__');
    return value;
  });
  expect(parseSnapshot(saved).notes[0]?.body).toBe('Newer text saved while the tag response was pending.');
  const visible = await page.evaluate(async () => {
    window.dispatchEvent(new Event('test-release-tag-reply'));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const title = document.querySelector('#note-title');
    const body = document.querySelector('#note-body');
    if (!(title instanceof HTMLInputElement) || !(body instanceof HTMLTextAreaElement)) throw new Error('Missing note editor');
    return { title: title.value, body: body.value };
  });
  // Check immediately: the regular three-second refresh must not mask a stale
  // response temporarily replacing the text the user just saved.
  expect(visible).toEqual({ title: 'A newer title', body: 'Newer text saved while the tag response was pending.' });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#note-tag-summary')).toContainText('studio');
});
