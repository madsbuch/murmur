import { expect, test } from '@playwright/test';
import { createPreviewNetwork, parsePreviewInvitation, sameInvitationSecret } from '../src/invitations';

const zeroSecretPhrase = 'abandon '.repeat(23) + 'art';
const zeroIdPhrase = 'abandon '.repeat(11) + 'about';

test('24-word invitations match the native zero-secret derivation vector', async () => {
  const network = await parsePreviewInvitation(zeroSecretPhrase);
  expect(network.id).toBe('4beeff20-5826-96b4-832c-9c895083db49');
  expect(network.name).toBe('Shared network');
  expect(network.phrase).toBe(zeroSecretPhrase);
  const viaQr = await parsePreviewInvitation(network.invite);
  expect(viaQr).toEqual(network);
  const prefixed = await parsePreviewInvitation(zeroSecretPhrase.split(' ').map(word => word.slice(0, 4).toUpperCase()).join('-'));
  expect(prefixed).toEqual(network);
});

test('36-word invitations preserve existing network IDs and secrets', async () => {
  const network = await parsePreviewInvitation(zeroIdPhrase + ' ' + zeroSecretPhrase);
  expect(network.id).toBe('00000000-0000-0000-0000-000000000000');
  expect(network.phrase.split(' ')).toHaveLength(36);
  const viaQr = await parsePreviewInvitation(network.invite);
  expect(viaQr).toEqual(network);
});

test('generated invitations round-trip offline and reject damaged words and checksums', async () => {
  const original = await createPreviewNetwork('My devices');
  expect(original.phrase.split(' ')).toHaveLength(24);
  const fromPhrase = await parsePreviewInvitation(original.phrase);
  expect(sameInvitationSecret(original, fromPhrase)).toBe(true);
  expect(fromPhrase.id).toBe(original.id);
  expect((await parsePreviewInvitation(original.invite)).name).toBe('My devices');
  await expect(parsePreviewInvitation('abandon '.repeat(24).trim())).rejects.toThrow('incomplete or invalid');
  await expect(parsePreviewInvitation('abandon '.repeat(23).trim())).rejects.toThrow('incomplete or invalid');
  await expect(parsePreviewInvitation('nonsense ' + zeroSecretPhrase.split(' ').slice(1).join(' '))).rejects.toThrow('incomplete or invalid');
});

test('welcome and settings contain functional controls without promotional copy', async ({ page }, testInfo) => {
  for (const width of [390, 1100]) {
    await page.setViewportSize({ width, height: 760 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Create a network', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Join a network', exact: true })).toBeVisible();
    await expect(page.locator('.signal-mark, .welcome-copy, .welcome-footer, .welcome-foot, .eyebrow')).toHaveCount(0);
    await expect(page.getByText('Keep it close.', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('welcome-' + width.toString() + '.png') });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
    await expect(page.getByText('Local by design', { exact: true })).toHaveCount(0);
    await expect(page.locator('.eyebrow, .about-card')).toHaveCount(0);
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(page.locator('.settings-card').first()).toHaveCSS('background-color', 'rgb(17, 25, 35)');
    await page.screenshot({ path: testInfo.outputPath('settings-' + width.toString() + '.png') });
  }
});

test('sharing exposes a numbered phrase without a raw ID and joining restores the saved network', async ({ page, context }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a network', exact: true }).click();
  await page.getByLabel('Network name').fill('My word network');
  await page.getByRole('button', { name: 'Create network', exact: true }).click();
  await page.getByRole('button', { name: 'My word network', exact: true }).click();
  await expect(page.locator('.phrase-grid li')).toHaveCount(24);
  await expect(page.locator('.network-id')).toHaveCount(0);
  await expect(page.getByRole('dialog')).not.toContainText('NETWORK ID');
  await page.getByRole('button', { name: 'Copy phrase', exact: true }).click();
  const phrase = await page.evaluate(() => navigator.clipboard.readText());
  expect(phrase.split(' ')).toHaveLength(24);
  expect(phrase).not.toContain('murmur://');
  await page.screenshot({ path: testInfo.outputPath('invitation-phrase.png') });
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Manage network', exact: true }).click();
  await page.getByRole('button', { name: 'Create another network', exact: true }).click();
  await page.getByLabel('Network name').fill('Another network');
  await page.getByRole('button', { name: 'Create network', exact: true }).click();
  await page.getByRole('button', { name: 'Manage network', exact: true }).click();
  await page.getByRole('button', { name: 'Join another network', exact: true }).click();
  await page.getByLabel('Invitation phrase').fill(phrase.split(' ').map(word => word.slice(0, 4).toUpperCase()).join('-'));
  await page.getByRole('button', { name: 'Join network', exact: true }).click();
  await expect(page.getByRole('button', { name: 'My word network', exact: true })).toBeVisible();
});
