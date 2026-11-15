import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import QRCode from 'qrcode';

const invitation = 'murmur://join#' + Buffer.from(JSON.stringify({
  v: 1,
  id: 'ab1631c5-7211-4989-a654-c96d73fb4a30',
  name: 'Camera fixture',
  secret: Buffer.alloc(32, 7).toString('base64url'),
})).toString('base64url');

type CameraMode = 'qr' | 'blank' | 'pending' | 'denied' | 'missing';

async function installCamera(page: Page, mode: CameraMode) {
  const image = await QRCode.toDataURL(invitation, { width: 640, margin: 4, errorCorrectionLevel: 'M' });
  await page.addInitScript(config => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 640;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Missing synthetic camera canvas');
    const image = new Image();
    const ready = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Synthetic QR image did not load'));
    });
    image.src = config.image;
    const streams: MediaStream[] = [];
    let calls = 0;
    let release: ((stream: MediaStream) => void) | null = null;

    function createStream(): MediaStream {
      if (context === null) throw new Error('Missing synthetic camera canvas');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (config.mode === 'qr') context.drawImage(image, 0, 0, 640, 640);
      const stream = canvas.captureStream(15);
      streams.push(stream);
      return stream;
    }

    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      calls++;
      if (config.mode === 'denied') throw new DOMException('Test camera permission denied', 'NotAllowedError');
      if (config.mode === 'missing') throw new DOMException('Test camera missing', 'NotFoundError');
      await ready;
      if (config.mode === 'pending') return new Promise<MediaStream>(resolve => { release = resolve; });
      return createStream();
    } });
    Object.defineProperty(window, '__MURMUR_CAMERA_TEST__', { get: () => ({
      calls,
      tracks: streams.flatMap(stream => stream.getTracks().map(track => track.readyState)),
    }) });
    window.addEventListener('release-test-camera', () => {
      if (release !== null) { const resolve = release; release = null; resolve(createStream()); }
    });
  }, { mode, image });
}

async function cameraState(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const state: unknown = Reflect.get(window, '__MURMUR_CAMERA_TEST__');
    return state;
  });
}

async function startScanner(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Join a network', exact: true }).click();
  await page.getByRole('button', { name: 'Scan QR code', exact: true }).click();
}

test('desktop camera decodes a real QR frame and releases the camera after joining', async ({ page }) => {
  await installCamera(page, 'qr');
  await startScanner(page);
  await expect(page.locator('.network-pill')).toContainText('Camera fixture');
  await expect(page.locator('#desktop-camera')).toHaveCount(0);
  await expect.poll(() => cameraState(page)).toEqual({ calls: 1, tracks: ['ended'] });
  await expect(page.getByRole('button', { name: 'New note', exact: true })).toBeVisible();
});

test('desktop camera cancellation and reopening leave no live tracks', async ({ page }) => {
  await installCamera(page, 'blank');
  await startScanner(page);
  await expect(page.locator('#camera-status')).toContainText('Hold a Murmur QR code');
  await expect.poll(() => cameraState(page)).toEqual({ calls: 1, tracks: ['live'] });
  await page.getByRole('button', { name: 'Cancel scanning', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Scan QR code', exact: true })).toBeVisible();
  await expect.poll(() => cameraState(page)).toEqual({ calls: 1, tracks: ['ended'] });
  await page.getByRole('button', { name: 'Scan QR code', exact: true }).click();
  await expect(page.locator('#camera-status')).toContainText('Hold a Murmur QR code');
  await expect.poll(() => cameraState(page)).toEqual({ calls: 2, tracks: ['ended', 'live'] });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Scan QR code', exact: true })).toBeVisible();
  await expect.poll(() => cameraState(page)).toEqual({ calls: 2, tracks: ['ended', 'ended'] });
});

test('a permission grant arriving after cancellation never reopens the camera', async ({ page }) => {
  await installCamera(page, 'pending');
  await startScanner(page);
  await expect.poll(() => cameraState(page)).toEqual({ calls: 1, tracks: [] });
  await page.getByRole('button', { name: 'Cancel scanning', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Scan QR code', exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('release-test-camera')));
  await expect.poll(() => cameraState(page)).toEqual({ calls: 1, tracks: ['ended'] });
  await expect(page.locator('#desktop-camera')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Join a network', exact: true })).toBeVisible();
});

for (const scenario of [
  { mode: 'denied', message: 'Camera access was denied' },
  { mode: 'missing', message: 'No camera was found' },
]) {
  test(`desktop camera reports ${scenario.mode} access and preserves manual joining`, async ({ page }) => {
    if (scenario.mode !== 'denied' && scenario.mode !== 'missing') throw new Error('Invalid test camera mode');
    await installCamera(page, scenario.mode);
    await startScanner(page);
    await expect(page.locator('#toast')).toContainText(scenario.message);
    await expect(page.getByRole('button', { name: 'Scan QR code', exact: true })).toBeVisible();
    await expect(page.locator('#network-invite')).toBeVisible();
    await expect.poll(() => cameraState(page)).toEqual({ calls: 1, tracks: [] });
  });
}
