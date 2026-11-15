import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { parseFileContent, parseSettings, parseSnapshot } from '../src/validation';
import type { Snapshot } from '../src/types';

async function imageBuffer(page: Page): Promise<Buffer> {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 200;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Missing canvas context');
    context.fillStyle = '#006b75';
    context.fillRect(0, 0, 320, 200);
    context.fillStyle = '#6be5e4';
    context.fillRect(40, 40, 240, 120);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  if (data === undefined) throw new Error('Missing PNG data');
  return Buffer.from(data, 'base64');
}
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF');

async function createNetwork(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a network', exact: true }).click();
  await page.getByLabel('Network name').fill('My devices');
  await page.getByRole('button', { name: 'Create network', exact: true }).click();
}

async function expectBounded(page: Page) {
  expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY, width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }))).toEqual(expect.objectContaining({ x: 0, y: 0 }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
}

test('system theme follows the device; explicit choices animate and ignore system changes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'System', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('.settings-card').first().evaluate(node => getComputedStyle(node).transitionDuration)).toContain('0.24s');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'System', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.locator('.settings-card').first().evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s');
});

test('shared images and PDFs are separate from notes, preview, save and delete', async ({ page }, testInfo) => {
  await createNetwork(page);
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByLabel('Choose files').setInputFiles([
    { name: 'photo.png', mimeType: 'image/png', buffer: await imageBuffer(page) },
    { name: 'document.pdf', mimeType: 'application/pdf', buffer: pdf },
  ]);
  await expect(page.locator('.file-card')).toHaveCount(2);
  await expect(page.locator('.file-card img')).toBeVisible();
  await expect(page.locator('[data-note]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview photo.png', exact: true }).click();
  await expect(page.getByRole('img', { name: 'photo.png', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'View document.pdf', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Save a copy to open it in your preferred app.');
  const downloadPending = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Save file', exact: true }).click();
  const download = await downloadPending;
  expect(download.suggestedFilename()).toBe('document.pdf');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Delete document.pdf', exact: true }).click();
  await page.getByRole('button', { name: 'Keep file', exact: true }).click();
  await expect(page.locator('.file-card')).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('files-phone.png') });
  for (const width of [430, 768, 1100]) {
    await page.setViewportSize({ width, height: width < 700 ? 850 : 760 });
    for (const theme of ['Light', 'Dark']) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: theme, exact: true }).click();
      await expect(page.locator('.settings-card').first()).toHaveCSS('background-color', theme === 'Dark' ? 'rgb(17, 25, 35)' : 'rgb(249, 252, 253)');
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      await expect(page.locator('.file-card img')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('files-' + width.toString() + '-' + theme.toLowerCase() + '.png') });
      await expectBounded(page);
    }
  }
  await page.getByRole('button', { name: 'Delete document.pdf', exact: true }).click();
  await page.getByRole('button', { name: 'Delete file', exact: true }).click();
  await expect(page.locator('.file-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(page.locator('[data-note]')).toHaveCount(0);
  await expectBounded(page);
});

for (const viewport of [{ width: 320, height: 568 }, { width: 430, height: 932 }, { width: 600, height: 960 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 1100, height: 760 }, { width: 1366, height: 1024 }]) {
  test(`bounded screens and keyboard viewport at ${viewport.width.toString()}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await createNetwork(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(page.locator('.settings-card').first()).toHaveCSS('background-color', 'rgb(17, 25, 35)');
    await expectBounded(page);
    await page.screenshot({ path: testInfo.outputPath('settings-dark.png') });
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await page.getByRole('button', { name: 'New note', exact: true }).click();
    await page.getByLabel('Note title').fill('Notes from the other side');
    await page.getByLabel('Note text').fill(Array.from({ length: 80 }, (_, i) => 'Line ' + i.toString() + ': Keep all of this text accessible.').join('\n'));
    await expect(page.locator('#save-state')).toContainText('Saved for this session');
    await page.getByLabel('Note text').press('ControlOrMeta+End');
    await page.screenshot({ path: testInfo.outputPath('editor-dark.png') });
    // Model the visual viewport shrinking and panning independently of layout.
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--app-height', '320px');
      document.documentElement.style.setProperty('--viewport-top', '30px');
      document.documentElement.classList.add('compact-height');
    });
    const body = await page.getByLabel('Note text').boundingBox();
    if (body === null) throw new Error('Missing text editor');
    expect(body.y).toBeGreaterThanOrEqual(30);
    expect(body.y + body.height).toBeLessThanOrEqual(350);
    expect(body.height).toBeGreaterThan(110);
    await page.getByLabel('Note text').fill('Typing while the keyboard is open.');
    await expect(page.locator('#save-state')).toContainText('Saved for this session');
    await page.mouse.wheel(0, 1500);
    await expectBounded(page);
    await page.screenshot({ path: testInfo.outputPath('keyboard.png') });
    await page.getByRole('button', { name: 'Delete this note' }).click();
    const modal = await page.getByRole('dialog').boundingBox();
    if (modal === null) throw new Error('Missing delete dialog');
    expect(modal.y).toBeGreaterThanOrEqual(30);
    expect(modal.y + modal.height).toBeLessThanOrEqual(350);
    await page.getByRole('button', { name: 'Keep note', exact: true }).click();
  });
}

const nativeSnapshot: Snapshot = {
  network: { id: 'files-network', name: 'Native files', invite: 'murmur://join#test', phrase: 'abandon '.repeat(23) + 'art' }, notes: [], heads: [],
  files: [{ id: 'pending', name: 'Incoming.pdf', mimeType: 'application/pdf', size: 40, sha256: 'hash', createdAt: 1, available: false, tags: [] }],
  status: { peers: 0, lastSync: null, error: null }, deviceId: 'test-device', listenerPort: 0,
};

test('native IPC validates file data, imports files and updates pending availability', async ({ page }) => {
  await page.addInitScript(initial => {
    const snapshot = structuredClone(initial);
    let theme = 'dark';
    let content = { name: 'Incoming.pdf', mimeType: 'application/pdf', dataBase64: 'JVBERg==' };
    window.addEventListener('test-peer-file-ready', () => { const file = snapshot.files[0]; if (file !== undefined) file.available = true; });
    Object.defineProperty(window, 'isTauri', { value: true });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {
      transformCallback: () => 1,
      invoke: (command: string, args: unknown): unknown => {
        if (command === 'bootstrap' || command === 'get_snapshot' || command === 'sync_now') return structuredClone(snapshot);
        if (command === 'get_pending_shares') return [];
        if (command === 'get_settings') return { theme };
        if (command === 'set_theme') {
          if (typeof args !== 'object' || args === null || !('theme' in args) || typeof args.theme !== 'string') throw new Error('Invalid theme request');
          theme = args.theme;
          return { theme };
        }
        if (command === 'import_file' || command === 'read_file' || command === 'delete_file') {
          if (typeof args !== 'object' || args === null || !('networkId' in args) || args.networkId !== 'files-network') throw new Error('Missing expected network ID');
        }
        if (command === 'import_file') {
          if (typeof args !== 'object' || args === null || !('name' in args) || !('mimeType' in args) || !('dataBase64' in args) || typeof args.name !== 'string' || typeof args.mimeType !== 'string' || typeof args.dataBase64 !== 'string') throw new Error('Invalid file request');
          content = { name: args.name, mimeType: args.mimeType, dataBase64: args.dataBase64 };
          snapshot.files.push({ id: 'imported', name: args.name, mimeType: args.mimeType, size: atob(args.dataBase64).length, sha256: 'hash', createdAt: 2, available: true, tags: [] });
          return structuredClone(snapshot);
        }
        if (command === 'read_file') return structuredClone(content);
        if (command === 'delete_file') { snapshot.files = snapshot.files.filter(file => file.id !== 'imported'); return structuredClone(snapshot); }
        if (command === 'plugin:lan|is_mobile') return false;
        if (command === 'plugin:event|listen') return 1;
        return null;
      },
    } });
  }, nativeSnapshot);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.getByText('Waiting for a nearby device')).toBeVisible();
  await expect(page.getByRole('button', { name: 'View Incoming.pdf' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeDisabled();
  await page.getByLabel('Choose files').setInputFiles({ name: 'Tablet.pdf', mimeType: 'application/pdf', buffer: pdf });
  await expect(page.getByRole('heading', { name: 'Tablet.pdf', exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('test-peer-file-ready')));
  await expect(page.getByRole('button', { name: 'View Incoming.pdf' })).toBeEnabled({ timeout: 6000 });
  await page.getByRole('button', { name: 'Delete Tablet.pdf' }).click();
  await page.getByRole('button', { name: 'Delete file', exact: true }).click();
  await expect(page.locator('.file-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Manage network', exact: true }).click();
  await page.getByRole('button', { name: 'Join another network', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Scan QR code', exact: true })).toBeVisible();
  await expect(page.getByLabel('Invitation phrase')).toBeVisible();
});

test('file/settings IPC rejects coercible and malformed values', () => {
  expect(() => parseSettings({ theme: 'automatic' })).toThrow();
  expect(() => parseSettings({ theme: null })).toThrow();
  expect(() => parseFileContent({ name: 'file', mimeType: 42, dataBase64: '' })).toThrow();
  expect(() => parseSnapshot({ ...nativeSnapshot, files: [{ ...nativeSnapshot.files[0], available: 'true' }] })).toThrow();
  expect(() => parseSnapshot({ ...nativeSnapshot, files: [{ ...nativeSnapshot.files[0], size: '40' }] })).toThrow();
});

test('arriving thumbnails preserve focus on file actions', async ({ page }) => {
  await page.addInitScript(() => {
    const encoder = document.createElement('canvas');
    const encode = encoder.toBlob.bind(encoder);
    HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback, type?: string, quality?: number) {
      window.addEventListener('release-test-thumbnail', () => {
        delete document.documentElement.dataset['thumbnailPending'];
        encode(callback, type, quality);
      }, { once: true });
      document.documentElement.dataset['thumbnailPending'] = 'true';
    };
  });
  await createNetwork(page);
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const image = await imageBuffer(page);
  await page.getByLabel('Choose files').setInputFiles([
    { name: 'First.png', mimeType: 'image/png', buffer: image },
    { name: 'Second.png', mimeType: 'image/png', buffer: image },
  ]);
  await expect(page.locator('.file-card')).toHaveCount(2);
  await expect(page.locator('html')).toHaveAttribute('data-thumbnail-pending', 'true');
  const save = page.getByRole('button', { name: 'Save file', exact: true }).first();
  await save.focus();
  await page.evaluate(() => window.dispatchEvent(new Event('release-test-thumbnail')));
  await expect(page.locator('.file-card img')).toHaveCount(1);
  await expect(save).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('data-thumbnail-pending', 'true');
  const remove = page.getByRole('button', { name: 'Delete Second.png', exact: true });
  await remove.focus();
  await page.evaluate(() => window.dispatchEvent(new Event('release-test-thumbnail')));
  await expect(page.locator('.file-card img')).toHaveCount(2);
  await expect(remove).toBeFocused();
});

for (const height of [200, 150]) {
  test('landscape editing keeps the caret and controls visible at ' + height.toString() + 'px height', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 960, height: 700 });
    await createNetwork(page);
    await page.getByRole('button', { name: 'New note', exact: true }).click();
    await page.getByLabel('Note title').fill('Landscape editing');
    const text = Array.from({ length: 30 }, (_, index) => 'Line ' + index.toString() + ': landscape keyboard').join('\n');
    await page.getByLabel('Note text').fill(text);
    await expect(page.locator('#save-state')).toContainText('Saved for this session');
    // Wide layouts retain the selected editor after returning to Notes.
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await page.getByRole('region', { name: 'Markdown preview' }).click();
    await expect(page.locator('.notebook-shell')).toHaveClass(/editor-open/);
    await page.setViewportSize({ width: 960, height });
    await expect(page.locator('.topbar')).toBeHidden();
    await expect(page.getByRole('navigation')).toBeHidden();
    await expect(page.locator('.sidebar')).toBeHidden();
    const body = page.getByLabel('Note text');
    const box = await body.boundingBox();
    if (box === null) throw new Error('Missing text editor');
    expect(box.height).toBeGreaterThanOrEqual(70);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    await body.evaluate(node => {
      if (!(node instanceof HTMLTextAreaElement)) throw new Error('Expected a textarea');
      node.setSelectionRange(node.value.length, node.value.length);
    });
    await body.press('Enter');
    await body.pressSequentially('The final line stays visible.');
    await expect(page.locator('#save-state')).toContainText('Saved for this session');
    await page.screenshot({ path: testInfo.outputPath('landscape-keyboard-' + height.toString() + '.png') });
    const caret = await body.evaluate(node => {
      if (!(node instanceof HTMLTextAreaElement)) throw new Error('Expected a textarea');
      return { atEnd: node.selectionStart === node.value.length, gap: node.scrollHeight - node.scrollTop - node.clientHeight };
    });
    expect(caret).toMatchObject({ atEnd: true });
    // Native caret scrolling may leave trailing padding/line leading below the viewport.
    expect(caret.gap).toBeLessThan(12);
    await expect(page.getByRole('button', { name: 'Notes', exact: true })).toBeVisible();
    const save = await page.locator('#save-state').boundingBox();
    if (save === null) throw new Error('Missing save control');
    expect(save.height).toBeGreaterThanOrEqual(44);
    await expectBounded(page);
    await page.screenshot({ path: testInfo.outputPath('landscape-keyboard-' + height.toString() + '.png') });
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.getByRole('navigation')).toBeVisible();
    const list = await page.locator('#note-list').boundingBox();
    if (list === null) throw new Error('Missing note list');
    expect(list.height).toBeGreaterThanOrEqual(44);
  });
}
