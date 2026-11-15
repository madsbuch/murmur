import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { FileContent, Snapshot } from '../src/types';
import { parseFileContent, record } from '../src/validation';

async function nativeClipboard(page: Page, options: { empty?: boolean; rejectRead?: boolean; rejectWrite?: boolean } = {}) {
  const snapshot: Snapshot = {
    network: { id: 'clipboard-network', name: 'Clipboard', invite: 'murmur://join#test', phrase: 'abandon '.repeat(23) + 'art' },
    notes: [{ id: 'note', title: 'A note', body: 'Keep this text.', updatedAt: 1, tags: [] }],
    files: [], heads: [], status: { peers: 0, lastSync: null, error: null }, deviceId: 'device', listenerPort: 0,
  };
  await page.addInitScript(config => {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 3;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Missing fixture canvas');
    context.fillStyle = '#112233';
    context.fillRect(0, 0, 4, 3);
    const dataBase64 = canvas.toDataURL('image/png').split(',')[1];
    if (dataBase64 === undefined) throw new Error('Missing fixture data');
    const source = { name: 'Existing.png', mimeType: 'image/png', dataBase64 };
    const clipboard = { ...source, name: 'Clipboard.png' };
    const snapshot = structuredClone(config.snapshot);
    snapshot.files.push({ id: 'existing', name: source.name, mimeType: source.mimeType, size: atob(dataBase64).length, sha256: 'hash', createdAt: 1, available: true, tags: [] });
    const content = new Map<string, FileContent>([['existing', source]]);
    const imports: FileContent[] = [];
    const writes: string[] = [];
    let reads = 0;
    Object.defineProperty(window, '__CLIPBOARD_TEST_STATE__', { get: () => ({ imports, writes, reads, source }) });
    Object.defineProperty(window, 'isTauri', { value: true });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {
      transformCallback: () => 1,
      invoke: (command: string, args: unknown): unknown => {
        if (command === 'bootstrap' || command === 'get_snapshot' || command === 'sync_now') return structuredClone(snapshot);
        if (command === 'get_settings') return { theme: 'system' };
        if (command === 'plugin:lan|is_mobile') return false;
        if (command === 'plugin:event|listen') return 1;
        if (command === 'get_pending_shares') return [];
        if (command === 'read_clipboard_image') {
          reads++;
          if (config.options.empty === true) throw new Error('There is no image on the clipboard.');
          if (config.options.rejectRead === true) throw new Error('Clipboard access was denied.');
          return structuredClone(clipboard);
        }
        if (command === 'write_clipboard_image') {
          if (typeof args !== 'object' || args === null || !('dataBase64' in args) || typeof args.dataBase64 !== 'string') throw new Error('Missing PNG bytes');
          if (config.options.rejectWrite === true) throw new Error('Clipboard write was denied.');
          writes.push(args.dataBase64);
          return null;
        }
        if (command === 'import_file') {
          if (typeof args !== 'object' || args === null || !('networkId' in args) || args.networkId !== 'clipboard-network' || !('name' in args) || !('mimeType' in args) || !('dataBase64' in args) || typeof args.name !== 'string' || typeof args.mimeType !== 'string' || typeof args.dataBase64 !== 'string') throw new Error('Invalid clipboard destination/content');
          const file = { name: args.name, mimeType: args.mimeType, dataBase64: args.dataBase64 };
          imports.push(file);
          const id = 'imported-' + imports.length.toString();
          content.set(id, file);
          snapshot.files.push({ id, name: file.name, mimeType: file.mimeType, size: atob(file.dataBase64).length, sha256: 'hash', createdAt: 2, available: true, tags: [] });
          return structuredClone(snapshot);
        }
        if (command === 'read_file') {
          if (typeof args !== 'object' || args === null || !('networkId' in args) || args.networkId !== 'clipboard-network' || !('id' in args) || typeof args.id !== 'string') throw new Error('Invalid file read');
          return structuredClone(content.get(args.id));
        }
        return null;
      },
    } });
  }, { snapshot, options });
  await page.goto('/');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
}

async function clipboardState(page: Page) {
  const value: unknown = await page.evaluate(() => { const state: unknown = Reflect.get(window, '__CLIPBOARD_TEST_STATE__'); return state; });
  return record(value);
}

async function expectPngPixels(page: Page, base64: string) {
  expect(Buffer.from(base64, 'base64').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const decoded = await page.evaluate(async bytes => {
    const image = await createImageBitmap(new Blob([Uint8Array.from(atob(bytes), value => value.charCodeAt(0))], { type: 'image/png' }));
    try {
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('Missing decoding canvas');
      context.drawImage(image, 0, 0);
      return { width: image.width, height: image.height, pixel: [...context.getImageData(0, 0, 1, 1).data] };
    } finally { image.close(); }
  }, base64);
  expect(decoded).toEqual({ width: 4, height: 3, pixel: [17, 34, 51, 255] });
}

test('native image clipboard imports into this network and copies real PNG pixels', async ({ page }) => {
  await nativeClipboard(page);
  await page.getByRole('button', { name: 'Paste image', exact: true }).click();
  await expect(page.locator('.file-card')).toHaveCount(2);
  const state = await clipboardState(page);
  expect(state['reads']).toBe(1);
  const imported = state['imports'];
  if (!Array.isArray(imported)) throw new Error('Missing imports');
  expect(imported).toHaveLength(1);
  const file = parseFileContent(imported[0]);
  expect(file.mimeType).toBe('image/png');
  expect(file.dataBase64).toBe(parseFileContent(state['source']).dataBase64);
  await page.getByRole('button', { name: 'Preview Existing.png', exact: true }).click();
  await page.getByRole('button', { name: 'Copy image', exact: true }).click();
  await expect(page.locator('#toast')).toContainText(/copied/i);
  const writes = (await clipboardState(page))['writes'];
  if (!Array.isArray(writes) || typeof writes[0] !== 'string') throw new Error('Missing copied PNG');
  expect(writes).toHaveLength(1);
  await expectPngPixels(page, writes[0]);
});

for (const failure of ['empty', 'rejectRead']) {
  test('native ' + failure + ' clipboard leaves existing files intact', async ({ page }) => {
    await nativeClipboard(page, failure === 'empty' ? { empty: true } : { rejectRead: true });
    await page.getByRole('button', { name: 'Paste image', exact: true }).click();
    await expect(page.locator('#toast')).toContainText(failure === 'empty' ? /no image/i : /denied/i);
    await expect(page.locator('.file-card')).toHaveCount(1);
    expect((await clipboardState(page))['imports']).toEqual([]);
    await expect(page.getByRole('button', { name: 'Paste image', exact: true })).toBeEnabled();
  });
}

test('a rejected clipboard write reports failure and keeps the image open', async ({ page }) => {
  await nativeClipboard(page, { rejectWrite: true });
  await page.getByRole('button', { name: 'Preview Existing.png', exact: true }).click();
  await page.getByRole('button', { name: 'Copy image', exact: true }).click();
  await expect(page.locator('#toast')).toContainText(/denied/i);
  await expect(page.locator('#toast')).not.toContainText(/copied/i);
  await expect(page.getByRole('img', { name: 'Existing.png', exact: true })).toBeVisible();
  expect((await clipboardState(page))['writes']).toEqual([]);
});

async function dispatchPaste(page: Page, image: boolean) {
  return page.evaluate(includeImage => {
    const data = new DataTransfer();
    if (includeImage) {
      const canvas = document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 3;
      const base64 = canvas.toDataURL('image/png').split(',')[1];
      if (base64 === undefined) throw new Error('Missing paste fixture');
      data.items.add(new File([Uint8Array.from(atob(base64), value => value.charCodeAt(0))], 'Pasted.png', { type: 'image/png' }));
    } else data.setData('text/plain', 'Normal clipboard text');
    const paste = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    (document.activeElement ?? document).dispatchEvent(paste);
    return paste.defaultPrevented;
  }, image);
}

test('keyboard image paste imports once; text paste and images outside Files remain untouched', async ({ page }) => {
  await nativeClipboard(page);
  expect(await dispatchPaste(page, true)).toBe(true);
  await expect(page.locator('.file-card')).toHaveCount(2);
  expect((await clipboardState(page))['imports']).toHaveLength(1);
  expect((await clipboardState(page))['reads']).toBe(0);
  expect(await dispatchPaste(page, false)).toBe(false);
  expect((await clipboardState(page))['imports']).toHaveLength(1);
  await page.getByRole('button', { name: 'Preview Existing.png', exact: true }).click();
  expect(await dispatchPaste(page, true)).toBe(false);
  expect((await clipboardState(page))['imports']).toHaveLength(1);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.locator('[data-note]').click();
  await page.getByRole('region', { name: 'Markdown preview' }).click();
  await expect(page.getByLabel('Note text')).toBeFocused();
  expect(await dispatchPaste(page, false)).toBe(false);
  expect(await dispatchPaste(page, true)).toBe(false);
  await expect(page.getByLabel('Note text')).toHaveValue('Keep this text.');
  expect((await clipboardState(page))['imports']).toHaveLength(1);
});

async function browserClipboard(page: Page, reject = false) {
  await page.addInitScript(denied => {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 3;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Missing clipboard canvas');
    context.fillStyle = '#112233';
    context.fillRect(0, 0, 4, 3);
    const bytes = canvas.toDataURL('image/png').split(',')[1];
    if (bytes === undefined) throw new Error('Missing clipboard fixture');
    const blob = new Blob([Uint8Array.from(atob(bytes), value => value.charCodeAt(0))], { type: 'image/png' });
    const writes: string[] = [];
    Object.defineProperty(window, '__CLIPBOARD_TEST_STATE__', { get: () => ({ writes }) });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      read: (): Promise<ClipboardItem[]> => denied ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) : Promise.resolve([new ClipboardItem({ 'image/png': blob })]),
      write: async (items: ClipboardItem[]): Promise<void> => {
        if (denied) throw new DOMException('Permission denied', 'NotAllowedError');
        for (const item of items) {
          const image = await item.getType('image/png');
          const bytes = new Uint8Array(await image.arrayBuffer());
          writes.push(btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')));
        }
      },
    } });
  }, reject);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a network', exact: true }).click();
  await page.getByLabel('Network name').fill('Browser clipboard');
  await page.getByRole('button', { name: 'Create network', exact: true }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
}

test('browser clipboard fallback imports and copies PNG content', async ({ page }) => {
  await browserClipboard(page);
  await page.getByRole('button', { name: 'Paste image', exact: true }).click();
  await expect(page.locator('.file-card')).toHaveCount(1);
  await page.locator('[data-open-file]').click();
  await page.getByRole('button', { name: 'Copy image', exact: true }).click();
  await expect(page.locator('#toast')).toContainText(/copied/i);
  const writes = (await clipboardState(page))['writes'];
  if (!Array.isArray(writes) || typeof writes[0] !== 'string') throw new Error('Missing browser clipboard write');
  expect(writes).toHaveLength(1);
  await expectPngPixels(page, writes[0]);
});

test('browser clipboard permission failure reports an error without adding files', async ({ page }) => {
  await browserClipboard(page, true);
  await page.getByRole('button', { name: 'Paste image', exact: true }).click();
  await expect(page.locator('#toast')).toContainText(/denied|permission|clipboard/i);
  await expect(page.locator('.file-card')).toHaveCount(0);
  await expect(page.locator('#toast')).not.toContainText(/added|copied/i);
});
