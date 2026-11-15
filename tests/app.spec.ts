import { test, expect } from '@playwright/test';
import type { Locator } from '@playwright/test';

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('Expected a visible element with bounds.');
  return box;
}
import { mapCaret, rebaseDraft } from '../src/rebase';

test('draft rebase preserves concurrent keystrokes and peer edits', () => {
  expect(rebaseDraft('hello', 'hello!', 'hello world')).toBe('hello world!');
  expect(rebaseDraft('abc', 'ac', 'aXbc')).toBe('aXc');
  expect(rebaseDraft('tea', 'green tea', 'tea and milk')).toBe('green tea and milk');
  expect(rebaseDraft('🍵', '🍵!', 'hot 🍵')).toBe('hot 🍵!');
  expect(rebaseDraft('same', 'same', 'new')).toBe('new');
  expect(mapCaret('tea', 'green tea', 3)).toBe(9);
});

test('preview editing, sharing, switching and restoring in the current session', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await expect(page.getByText('Browser preview', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Create a network', exact: true }).click();
  await page.getByLabel('Network name').fill('Kitchen table');
  await page.getByRole('button', { name: 'Create network', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Kitchen table', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New note', exact: true }).filter({ visible: true }).first().click();
  await page.getByRole('textbox', { name: 'Note title' }).fill('Weekend plans');
  await page.getByRole('textbox', { name: 'Note text' }).fill('Bring tea and a notebook. 🍵');
  await expect(page.getByText('Saved for this session', { exact: true })).toBeVisible();

  await expect(page.getByRole('textbox', { name: 'Note text' })).toHaveValue('Bring tea and a notebook. 🍵');
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.getByRole('button', { name: 'Kitchen table', exact: true }).click();
  await expect(page.getByRole('img', { name: 'QR invitation for Kitchen table' })).toBeVisible();
  await expect(page.getByText('This code contains your shared secret.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Copy invitation', exact: true }).click();
  const invite = await page.evaluate(() => navigator.clipboard.readText());
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Manage network' }).click();
  await page.getByRole('button', { name: 'Create another network' }).click();
  await page.getByLabel('Network name').fill('Another circle');
  await page.getByRole('button', { name: 'Create network', exact: true }).click();
  await expect(page.locator('[data-note]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage network' }).click();
  await page.getByRole('button', { name: 'Join another network' }).click();
  await page.getByLabel('Network invitation').fill(invite);
  await page.getByRole('button', { name: 'Join network', exact: true }).click();
  await page.locator('[data-note]').filter({ hasText: 'Weekend plans' }).click();
  await expect(page.getByRole('textbox', { name: 'Note text' })).toHaveValue('Bring tea and a notebook. 🍵');
  await page.getByRole('button', { name: 'Delete this note' }).click();
  await page.getByRole('button', { name: 'Delete note', exact: true }).click();
  await expect(page.locator('[data-note]')).toHaveCount(0);
});

test('reject an invalid invitation and retain a usable join form', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Join a network', exact: true }).click();
  await page.getByLabel('Network invitation').fill('https://unrelated.example');
  await page.getByRole('button', { name: 'Join network', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('not a Murmur invitation');
  await expect(page.getByRole('dialog', { name: 'Join a network' })).toBeVisible();
});

test('network dialog stays within the visual viewport above a keyboard', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a network', exact: true }).click();
  // A mobile keyboard can shrink VisualViewport without changing the layout viewport.
  await page.evaluate(() => document.documentElement.style.setProperty('--app-height', '360px'));
  const dialog = await bounds(page.getByRole('dialog'));
  expect(dialog.y + dialog.height).toBeLessThanOrEqual(360);
  await page.getByLabel('Network name').fill('Keyboard check');
  await page.getByRole('button', { name: 'Create network', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Keyboard check', exact: true })).toBeVisible();
});

for (const viewport of [{ width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 1366, height: 1024 }, { width: 600, height: 960 }, { width: 320, height: 568 }]) {
  test(`touch layout and editing at ${viewport.width.toString()}×${viewport.height.toString()}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByRole('button', { name: 'Create a network', exact: true }).click();
    await page.getByLabel('Network name').fill('Our little corner');
    await page.getByRole('button', { name: 'Create network', exact: true }).click();
    await page.getByRole('button', { name: 'New note', exact: true }).filter({ visible: true }).first().click();
    await page.getByRole('textbox', { name: 'Note title' }).fill('A slow Sunday');
    await page.getByRole('textbox', { name: 'Note text' }).fill('Meet by the water at ten.\n\nBring the good coffee, a warm layer, and something to write in.\n\nSmall plans. Plenty of room.');
    await expect(page.getByText('Saved for this session', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    if (viewport.width > 640) {
      await expect(page.locator('.sidebar')).toBeVisible();
      await expect(page.locator('.editor-panel')).toBeVisible();
      const sidebar = await bounds(page.locator('.sidebar'));
      const editor = await bounds(page.locator('.editor-panel'));
      expect(editor.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width - 1);
    } else {
      await expect(page.locator('.sidebar')).toBeHidden();
      await expect(page.getByRole('button', { name: 'Notes', exact: true })).toBeVisible();
    }
    const deleteBox = await bounds(page.getByRole('button', { name: 'Delete this note' }));
    expect(deleteBox.width).toBeGreaterThanOrEqual(44);
    expect(deleteBox.height).toBeGreaterThanOrEqual(44);
    const bodyBox = await bounds(page.getByRole('textbox', { name: 'Note text' }));
    expect(bodyBox.width).toBeGreaterThan(240);
    await page.screenshot({ path: testInfo.outputPath(`editor-${viewport.width.toString()}.png`), fullPage: true });
    // A software keyboard shortens the usable viewport. Editing controls must remain reachable.
    await page.setViewportSize({ width: viewport.width, height: Math.max(340, viewport.height - 350) });
    await expect(page.getByRole('textbox', { name: 'Note text' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.getByRole('textbox', { name: 'Note text' }).fill('Still writing with the keyboard open.');
    await expect(page.getByText('Saved for this session', { exact: true })).toBeVisible();
  });
}

test('browser preview clears on reload and does not write durable notebook storage', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Temporary demo; reload clears these notes.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Create a network', exact: true }).click();
  await page.getByLabel('Network name').fill('Temporary');
  await page.getByRole('button', { name: 'Create network', exact: true }).click();
  await page.getByRole('button', { name: 'New note', exact: true }).filter({ visible: true }).first().click();
  await page.getByRole('textbox', { name: 'Note text' }).fill('Only a demonstration');
  await expect(page.getByText('Saved for this session', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Create a network', exact: true })).toBeVisible();
});
