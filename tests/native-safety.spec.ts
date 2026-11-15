import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { DraftBackup, Snapshot } from '../src/types';
import { parseDraft, parseSnapshot, record } from '../src/validation';

const initial: Snapshot = {
  network: { id: 'network', name: 'Native notebook', invite: 'murmur://join#test' },
  notes: [{ id: 'note', title: 'Stored title', body: 'Stored text', updatedAt: 1 }],
  heads: ['revision'], status: { peers: 0, lastSync: null, error: null },
  deviceId: 'device', listenerPort: 0,
};
const backup: DraftBackup = { networkId: 'network', id: 'note', title: 'Recovered title', body: 'Recovered typing', baseHeads: ['revision'] };

async function mockNative(page: Page, options: { snapshot: Snapshot; draft: DraftBackup | null; legacy?: string; failBackups?: boolean; delayRecovery?: boolean; failClearOnce?: boolean }) {
  await page.addInitScript(config => {
    let snapshot = structuredClone(config.snapshot);
    let draft = structuredClone(config.draft);
    let failures = config.failBackups === true;
    let saves = 0;
    let clears = 0;
    let updates = 0;
    window.addEventListener('allow-test-backups', () => { failures = false; });
    if (config.legacy !== undefined) localStorage.setItem('murmur-unsaved-draft', config.legacy);
    Object.defineProperty(window, 'isTauri', { value: true });
    Object.defineProperty(window, '__MURMUR_TEST_STATE__', { get: () => ({ snapshot, draft, saves, clears, updates }) });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {
      transformCallback: () => 1,
      invoke: (command: string, args: unknown): unknown => {
        if (command === 'bootstrap' || command === 'get_snapshot' || command === 'sync_now') return structuredClone(snapshot);
        if (command === 'get_draft') {
          if (config.delayRecovery === true) return new Promise<unknown>(resolve => {
            window.addEventListener('release-test-recovery', () => resolve(structuredClone(draft)), { once: true });
          });
          return structuredClone(draft);
        }
        if (command === 'plugin:lan|is_mobile') return false;
        if (command === 'plugin:event|listen') return 1;
        if (command === 'save_draft' || command === 'import_draft') {
          saves++;
          if (failures) throw new Error('Temporary database write failure');
          if (typeof args !== 'object' || args === null || !('draft' in args)) throw new Error('Invalid draft request');
          const value = args.draft;
          if (typeof value !== 'object' || value === null || !('networkId' in value) || !('id' in value) || !('title' in value) || !('body' in value) || !('baseHeads' in value)) throw new Error('Invalid draft');
          if (typeof value.networkId !== 'string' || typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.body !== 'string' || !Array.isArray(value.baseHeads)) throw new Error('Invalid draft fields');
          const heads = value.baseHeads.map((head: unknown) => { if (typeof head !== 'string') throw new Error('Invalid head'); return head; });
          if (command !== 'import_draft' || draft === null) draft = { networkId: value.networkId, id: value.id, title: value.title, body: value.body, baseHeads: heads };
          return null;
        }
        if (command === 'clear_draft') {
          clears++;
          if (config.failClearOnce === true && clears === 1) throw new Error('Temporary cleanup failure');
          draft = null;
          return null;
        }
        if (command === 'delete_note') { snapshot.notes = []; draft = null; return structuredClone(snapshot); }
        if (command === 'update_note') {
          updates++;
          if (typeof args !== 'object' || args === null || !('id' in args) || !('title' in args) || !('body' in args)) throw new Error('Invalid edit');
          const note = snapshot.notes.find(entry => entry.id === args.id);
          if (note === undefined || typeof args.title !== 'string' || typeof args.body !== 'string') throw new Error('The original note was deleted');
          note.title = args.title;
          note.body = args.body;
          snapshot = { ...snapshot, heads: ['saved-revision'] };
          return structuredClone(snapshot);
        }
        return null;
      },
    } });
  }, options);
}

async function state(page: Page) {
  const value: unknown = await page.evaluate(() => {
    const result: unknown = Reflect.get(window, '__MURMUR_TEST_STATE__');
    return result;
  });
  return record(value);
}

test('runtime validation rejects malformed IPC and recovery data without coercing it', () => {
  expect(() => parseSnapshot({ ...initial, listenerPort: '12' })).toThrow();
  expect(() => parseSnapshot({ ...initial, notes: [{ id: 'n', title: 17, body: '', updatedAt: 1 }] })).toThrow();
  expect(() => parseSnapshot({ ...initial, status: { peers: Number.NaN, lastSync: null, error: null } })).toThrow();
  expect(() => parseDraft({ ...backup, baseHeads: [false] })).toThrow();
  expect(() => parseDraft({ ...backup, body: null })).toThrow();
});

test('explicit save retry recovers after failed SQLite draft writes without another keystroke', async ({ page }) => {
  await mockNative(page, { snapshot: initial, draft: null, failBackups: true });
  await page.goto('/');
  await page.locator('[data-note]').click();
  await page.getByRole('textbox', { name: 'Note text' }).fill('Latest typing survives');
  await expect(page.locator('#save-state')).toHaveText('Not saved · tap to retry');
  expect((await state(page))['updates']).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event('allow-test-backups')));
  await page.locator('#save-state').click();
  await expect(page.locator('#save-state')).toContainText('Saved on device');
  const saved = await state(page);
  expect(parseSnapshot(saved['snapshot']).notes[0]?.body).toBe('Latest typing survives');
  expect(saved['draft']).toBeNull();
});

test('a malformed legacy backup does not prevent recovering the newer SQLite draft', async ({ page }) => {
  await mockNative(page, { snapshot: initial, draft: backup, legacy: '{malformed' });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Note text' })).toHaveValue('Recovered typing');
  await expect(page.locator('#save-state')).toContainText('Saved on device');
  expect(await page.evaluate(() => localStorage.getItem('murmur-unsaved-draft'))).toBe('{malformed');
  expect(parseSnapshot((await state(page))['snapshot']).notes[0]?.body).toBe('Recovered typing');
});

test('a draft whose original note was deleted remains visible and copyable', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockNative(page, { snapshot: { ...initial, notes: [] }, draft: backup });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Note text' })).toHaveValue('Recovered typing');
  await expect(page.locator('#save-state')).toHaveText('Original note deleted · draft recovered');
  await page.getByRole('button', { name: 'Copy recovered text', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Recovered title\n\nRecovered typing');
  expect((await state(page))['updates']).toBe(0);
});

test('editing stays gated until delayed SQLite recovery completes', async ({ page }) => {
  await mockNative(page, { snapshot: initial, draft: backup, delayRecovery: true });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveJSProperty('inert', true);
  await page.evaluate(() => window.dispatchEvent(new Event('release-test-recovery')));
  await expect(page.locator('#app')).toHaveJSProperty('inert', false);
  await expect(page.getByRole('textbox', { name: 'Note text' })).toHaveValue('Recovered typing');
});

test('failed cleanup after a committed note remains explicitly retryable', async ({ page }) => {
  await mockNative(page, { snapshot: initial, draft: null, failClearOnce: true });
  await page.goto('/');
  await page.locator('[data-note]').click();
  await page.getByRole('textbox', { name: 'Note text' }).fill('Committed typing');
  await expect(page.locator('#save-state')).toHaveText('Not saved · tap to retry');
  expect(parseSnapshot((await state(page))['snapshot']).notes[0]?.body).toBe('Committed typing');
  await page.locator('#save-state').click();
  await expect(page.locator('#save-state')).toContainText('Saved on device');
  expect((await state(page))['draft']).toBeNull();
  expect(parseSnapshot((await state(page))['snapshot']).notes[0]?.body).toBe('Committed typing');
});

test('explicit deletion remains available after a failed recovery write', async ({ page }) => {
  await mockNative(page, { snapshot: initial, draft: null, failBackups: true });
  await page.goto('/');
  await page.locator('[data-note]').click();
  await page.getByRole('textbox', { name: 'Note text' }).fill('Discard this typing');
  await expect(page.locator('#save-state')).toHaveText('Not saved · tap to retry');
  await page.getByRole('button', { name: 'Delete this note', exact: true }).click();
  await page.getByRole('button', { name: 'Delete note', exact: true }).click();
  await expect(page.locator('[data-note]')).toHaveCount(0);
  expect((await state(page))['draft']).toBeNull();
});
