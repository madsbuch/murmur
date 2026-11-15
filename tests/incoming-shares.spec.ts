import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { PendingShare, Snapshot } from '../src/types';
import { parsePendingShares, parseSnapshot, record } from '../src/validation';

const network = { id: 'network', name: 'My devices', invite: 'murmur://join#test', phrase: 'abandon '.repeat(23) + 'art' };
const initial: Snapshot = {
  network, notes: [{ id: 'note', title: 'A note', body: 'Saved text', updatedAt: 1, tags: [] }], files: [], heads: ['head'],
  status: { peers: 0, lastSync: null, error: null }, deviceId: 'device', listenerPort: 0,
};
const incoming: PendingShare[] = [
  { id: 'picture', name: 'Screenshot.png', mimeType: 'image/png', size: 200 },
  { id: 'document', name: 'Document.pdf', mimeType: 'application/pdf', size: 300 },
];

async function mockShares(page: Page, options: { noNetwork?: boolean; receiveLater?: boolean; failImport?: boolean; delayRecovery?: boolean; delayImport?: boolean } = {}) {
  await page.addInitScript(config => {
    let snapshot = structuredClone(config.initial);
    if (config.options.noNetwork === true) snapshot = { ...snapshot, network: null, notes: [] };
    let pending = config.options.receiveLater === true ? [] : structuredClone(config.incoming);
    let failImport = config.options.failImport === true;
    let imports = 0;
    let discarded = 0;
    const operations: string[] = [];
    const callbacks = new Map<number, (event: unknown) => void>();
    let nextCallback = 1;
    let sharesCallback: ((event: unknown) => void) | undefined;
    const announce = () => sharesCallback?.({ event: 'share_received', id: 1, payload: null });
    window.addEventListener('test-receive-shares', () => { pending = structuredClone(config.incoming); announce(); });
    window.addEventListener('test-repeat-share-event', announce);
    window.addEventListener('test-allow-import', () => { failImport = false; });
    Object.defineProperty(window, 'isTauri', { value: true });
    Object.defineProperty(window, '__SHARE_TEST_STATE__', { get: () => ({ snapshot, pending, imports, discarded, operations }) });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {
      transformCallback: (callback: (event: unknown) => void) => { const id = nextCallback++; callbacks.set(id, callback); return id; },
      invoke: (command: string, args: unknown): unknown => {
        if (command === 'bootstrap' || command === 'get_snapshot' || command === 'sync_now') return structuredClone(snapshot);
        if (command === 'get_settings') return { theme: 'system' };
        if (command === 'plugin:lan|is_mobile') return false;
        if (command === 'plugin:event|listen') {
          if (typeof args === 'object' && args !== null && 'event' in args && args.event === 'share_received' && 'handler' in args && typeof args.handler === 'number') sharesCallback = callbacks.get(args.handler);
          return 1;
        }
        if (command === 'get_draft') {
          if (config.options.delayRecovery === true) return new Promise<null>(resolve => window.addEventListener('test-release-recovery', () => resolve(null), { once: true }));
          return null;
        }
        if (command === 'create_network') { snapshot = { ...snapshot, network: config.initial.network }; return structuredClone(snapshot); }
        if (command === 'get_pending_shares') return structuredClone(pending);
        if (command === 'discard_pending_shares') { discarded++; pending = []; return null; }
        if (command === 'import_pending_shares') {
          imports++;
          operations.push('import');
          if (typeof args !== 'object' || args === null || !('networkId' in args) || args.networkId !== snapshot.network?.id) throw new Error('Wrong destination network');
          if (failImport) throw new Error('Network storage is full');
          const commit = () => {
            snapshot.files.push(...pending.map(file => ({ ...file, sha256: 'hash', createdAt: 1, available: true, tags: [] })));
            pending = [];
            return structuredClone(snapshot);
          };
          if (config.options.delayImport === true) return new Promise<Snapshot>(resolve => window.addEventListener('test-release-import', () => resolve(commit()), { once: true }));
          return commit();
        }
        if (command === 'update_note') {
          if (typeof args !== 'object' || args === null || !('title' in args) || !('body' in args) || typeof args.title !== 'string' || typeof args.body !== 'string') throw new Error('Invalid note');
          const note = snapshot.notes[0];
          if (note === undefined) throw new Error('Missing note');
          operations.push('save-note');
          note.title = args.title;
          note.body = args.body;
          return structuredClone(snapshot);
        }
        if (command === 'read_file') throw new Error('Thumbnail omitted by fixture');
        return null;
      },
    } });
  }, { initial, incoming, options });
}

async function shareState(page: Page) {
  const value: unknown = await page.evaluate(() => {
    const result: unknown = Reflect.get(window, '__SHARE_TEST_STATE__');
    return result;
  });
  return record(value);
}

async function signal(page: Page, name: string) {
  await page.evaluate(eventName => window.dispatchEvent(new Event(eventName)), name);
}

test('incoming files import once into the active network and open Files', async ({ page }) => {
  await mockShares(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Shared files', exact: false })).toBeVisible();
  await expect(page.locator('.file-card')).toHaveCount(2);
  expect((await shareState(page))['imports']).toBe(1);
  expect((await shareState(page))['pending']).toEqual([]);
  await signal(page, 'test-repeat-share-event');
  await expect(page.locator('#pending-share-status')).toBeHidden();
  expect((await shareState(page))['imports']).toBe(1);
});

test('a queued share survives without a network until one is created', async ({ page }, testInfo) => {
  await mockShares(page, { noNetwork: true });
  await page.goto('/');
  await expect(page.getByText('2 files ready to add', { exact: true })).toBeVisible();
  expect((await shareState(page))['imports']).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('incoming-without-network.png') });
  await page.getByRole('button', { name: 'Create a network', exact: true }).click();
  await page.getByLabel('Network name').fill('My devices');
  await page.getByRole('button', { name: 'Create network', exact: true }).click();
  await expect(page.locator('.file-card')).toHaveCount(2);
  expect((await shareState(page))['imports']).toBe(1);
});

test('incoming imports wait for recovery and do not bypass its edit gate', async ({ page }) => {
  await mockShares(page, { delayRecovery: true });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveJSProperty('inert', true);
  await page.keyboard.press('Escape');
  expect((await shareState(page))['imports']).toBe(0);
  await signal(page, 'test-release-recovery');
  await expect(page.locator('.file-card')).toHaveCount(2);
  await expect(page.locator('#app')).toHaveJSProperty('inert', false);
});

test('failed imports retain their queue, throttle retries, and allow explicit retry', async ({ page }, testInfo) => {
  await page.clock.install();
  await mockShares(page, { failImport: true });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Retry import', exact: true })).toBeVisible();
  expect((await shareState(page))['imports']).toBe(1);
  expect((await shareState(page))['pending']).toHaveLength(2);
  await page.clock.fastForward(12_000);
  expect((await shareState(page))['imports']).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('incoming-retry.png') });
  await signal(page, 'test-allow-import');
  await page.getByRole('button', { name: 'Retry import', exact: true }).click();
  await expect(page.locator('.file-card')).toHaveCount(2);
  expect((await shareState(page))['imports']).toBe(2);
});

test('typing during a shared-file import is saved before opening Files', async ({ page }) => {
  await mockShares(page, { receiveLater: true, delayImport: true });
  await page.goto('/');
  await page.locator('[data-note]').click();
  await page.getByRole('region', { name: 'Markdown preview' }).click();
  await page.getByLabel('Note text').fill('Before sharing');
  await expect(page.locator('#save-state')).toContainText('Saved on device');
  await signal(page, 'test-receive-shares');
  await expect.poll(async () => (await shareState(page))['imports']).toBe(1);
  await page.getByLabel('Note text').fill('Typing during the import');
  await signal(page, 'test-release-import');
  await expect(page.locator('.file-card')).toHaveCount(2);
  expect(parseSnapshot((await shareState(page))['snapshot']).notes[0]?.body).toBe('Typing during the import');
  expect((await shareState(page))['operations']).toEqual(['save-note', 'import', 'save-note']);
});

test('network dialogs defer auto-import until closed', async ({ page }) => {
  await mockShares(page, { receiveLater: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Manage network', exact: true }).click();
  await signal(page, 'test-receive-shares');
  await expect(page.locator('#pending-share-status')).toContainText('2 files ready to add');
  expect((await shareState(page))['imports']).toBe(0);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.locator('.file-card')).toHaveCount(2);
});

test('queued copies can be discarded without importing them', async ({ page }) => {
  await mockShares(page, { noNetwork: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Original files are unchanged.');
  await page.getByRole('button', { name: 'Keep files', exact: true }).click();
  expect((await shareState(page))['discarded']).toBe(0);
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.getByRole('button', { name: 'Discard files', exact: true }).click();
  await expect(page.locator('#pending-share-status')).toBeHidden();
  const state = await shareState(page);
  expect(state['imports']).toBe(0);
  expect(state['discarded']).toBe(1);
  expect(state['pending']).toEqual([]);
});

test('incoming queue validation rejects coercions and invalid sizes', () => {
  expect(parsePendingShares(incoming)).toEqual(incoming);
  expect(() => parsePendingShares([{ ...incoming[0], size: '200' }])).toThrow();
  expect(() => parsePendingShares([{ ...incoming[0], size: -1 }])).toThrow();
  expect(() => parsePendingShares([{ ...incoming[0], size: 26 * 1024 * 1024 }])).toThrow();
  expect(() => parsePendingShares([{ ...incoming[0], name: null }])).toThrow();
});
