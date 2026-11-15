import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { FileContent, Snapshot } from '../src/types';

function waveBuffer(): Buffer {
  const sampleRate = 8000;
  const samples = sampleRate * 4;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    bytes.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 220 / sampleRate) * 1000), 44 + index * 2);
  }
  return bytes;
}

async function openFiles(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a network', exact: true }).click();
  await page.getByLabel('Network name').fill('Preview files');
  await page.getByRole('button', { name: 'Create network', exact: true }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
}

test('audio plays, seeks and pauses inside a bounded phone preview, and closes cleanly', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openFiles(page);
  // File providers can omit a meaningful MIME type. The extension still identifies audio.
  await page.getByLabel('Choose files').setInputFiles({ name: 'Evening track.WAV', mimeType: 'application/octet-stream', buffer: waveBuffer() });
  await page.getByRole('button', { name: 'View Evening track.WAV', exact: true }).click();
  const audio = page.locator('audio');
  await expect(audio).toBeVisible();
  await expect(audio).toHaveAttribute('aria-label', 'Evening track.WAV');
  await expect(audio).toHaveJSProperty('controls', true);
  await expect(audio).toHaveJSProperty('paused', true);
  await expect.poll(() => audio.evaluate(node => node instanceof HTMLAudioElement ? node.duration : 0)).toBeCloseTo(4, 1);
  await audio.evaluate(async node => {
    if (!(node instanceof HTMLAudioElement)) throw new Error('Missing audio player');
    await node.play();
  });
  await expect.poll(() => audio.evaluate(node => node instanceof HTMLAudioElement ? node.currentTime : 0)).toBeGreaterThan(0);
  await audio.evaluate(node => {
    if (!(node instanceof HTMLAudioElement)) throw new Error('Missing audio player');
    node.pause();
    node.currentTime = 2;
  });
  await expect(audio).toHaveJSProperty('paused', true);
  await expect.poll(() => audio.evaluate(node => node instanceof HTMLAudioElement ? node.currentTime : 0)).toBeCloseTo(2, 1);
  const box = await audio.boundingBox();
  if (box === null) throw new Error('Missing audio bounds');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('audio-phone-preview.png') });
  const player = await audio.elementHandle();
  if (player === null) throw new Error('Missing audio element');
  const url = await audio.getAttribute('src');
  if (url === null) throw new Error('Missing audio URL');
  await audio.evaluate(async node => {
    if (!(node instanceof HTMLAudioElement)) throw new Error('Missing audio player');
    await node.play();
  });
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await player.evaluate(node => node instanceof HTMLAudioElement && node.paused)).toBe(true);
  expect(await page.evaluate(async source => {
    try { await fetch(source); return false; }
    catch { return true; }
  }, url)).toBe(true);
  await expect(page.getByRole('button', { name: 'View Evening track.WAV', exact: true })).toBeFocused();
  await player.dispose();
});

test('malformed audio explains the playback failure and keeps saving available', async ({ page }) => {
  await openFiles(page);
  await page.getByLabel('Choose files').setInputFiles({ name: 'Broken.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('This is not an audio track.') });
  await page.getByRole('button', { name: 'View Broken.mp3', exact: true }).click();
  const status = page.getByRole('dialog').locator('.file-preview-status');
  await expect(status).toBeVisible();
  await expect(status).toContainText('This audio format cannot be played on this device.');
  await expect(status).toContainText('Save the file to open it in another app.');
  const downloadPending = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Save file', exact: true }).click();
  expect((await downloadPending).suggestedFilename()).toBe('Broken.mp3');
});

test('video has inline playback controls inside the app', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openFiles(page);
  // A one-second, silent VP8 color clip generated for this test; no remote media is used.
  await page.getByLabel('Choose files').setInputFiles('tests/fixtures/preview.webm');
  await page.getByRole('button', { name: 'View preview.webm', exact: true }).click();
  const video = page.locator('video');
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute('aria-label', 'preview.webm');
  await expect(video).toHaveJSProperty('controls', true);
  await expect(video).toHaveJSProperty('playsInline', true);
  await expect.poll(() => video.evaluate(node => node instanceof HTMLVideoElement ? node.videoWidth : 0)).toBe(96);
  await video.evaluate(async node => {
    if (!(node instanceof HTMLVideoElement)) throw new Error('Missing video player');
    await node.play();
  });
  await expect.poll(() => video.evaluate(node => node instanceof HTMLVideoElement ? node.currentTime : 0)).toBeGreaterThan(0);
  const bounds = await video.boundingBox();
  if (bounds === null) throw new Error('Missing video bounds');
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.locator('video')).toHaveCount(0);
});

test('plain text stays literal while markdown files render a readable preview', async ({ page }) => {
  await openFiles(page);
  const text = '<img src=x onerror="window.previewInjected=true">\n# This stays plain text\nA < B & B > C';
  await page.getByLabel('Choose files').setInputFiles([
    { name: 'Readme.txt', mimeType: 'text/plain', buffer: Buffer.from(text) },
    { name: 'Readme.md', mimeType: 'application/octet-stream', buffer: Buffer.from('# Session notes\n\nListen to **Evening track**.\n\n- First mix\n- Final mix') },
  ]);
  await page.getByRole('button', { name: 'View Readme.txt', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(text);
  await expect(page.getByRole('dialog').locator('img')).toHaveCount(0);
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'This stays plain text' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'View Readme.md', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Session notes', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').locator('strong')).toHaveText('Evening track');
  await expect(page.getByRole('dialog').locator('li')).toHaveText(['First mix', 'Final mix']);
});

test('a dismissed native file read cannot reopen its preview when it finishes', async ({ page }) => {
  const bytes = waveBuffer();
  const content: FileContent = { name: 'Slow.wav', mimeType: 'audio/wav', dataBase64: bytes.toString('base64') };
  const snapshot: Snapshot = {
    network: { id: 'preview-network', name: 'Native preview', invite: 'murmur://join#test', phrase: 'abandon '.repeat(23) + 'art' },
    notes: [], heads: [], status: { peers: 0, lastSync: null, error: null }, deviceId: 'test-device', listenerPort: 0,
    files: [{ id: 'slow-track', name: content.name, mimeType: content.mimeType, size: bytes.length, sha256: 'hash', createdAt: 1, available: true }],
  };
  await page.addInitScript(config => {
    Object.defineProperty(window, 'isTauri', { value: true });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {
      transformCallback: () => 1,
      invoke: (command: string, args: unknown): unknown => {
        if (command === 'bootstrap' || command === 'get_snapshot' || command === 'sync_now') return structuredClone(config.snapshot);
        if (command === 'get_pending_shares') return [];
        if (command === 'get_settings') return { theme: 'system' };
        if (command === 'plugin:lan|is_mobile') return false;
        if (command === 'plugin:event|listen') return 1;
        if (command === 'read_file') {
          if (typeof args !== 'object' || args === null || !('networkId' in args) || args.networkId !== 'preview-network' || !('id' in args) || args.id !== 'slow-track') throw new Error('Unexpected file read');
          return new Promise<FileContent>(resolve => window.addEventListener('test-release-file', () => resolve(structuredClone(config.content)), { once: true }));
        }
        return null;
      },
    } });
  }, { snapshot, content });
  await page.goto('/');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'View Slow.wav', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Loading preview…');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    window.dispatchEvent(new Event('test-release-file'));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('audio')).toHaveCount(0);
  await expect(page.locator('#app')).toHaveJSProperty('inert', false);
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'View Slow.wav', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Loading preview…');
  await page.evaluate(() => window.dispatchEvent(new Event('test-release-file')));
  await expect(page.locator('audio')).toBeVisible();
});
