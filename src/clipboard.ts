import { invoke } from '@tauri-apps/api/core';
import { native } from './bridge';
import { describeFilePreview } from './file-preview';
import { fileBlob, MAX_FILE_BYTES, readSelectedFile } from './files';
import type { FileContent } from './types';
import { parseFileContent } from './validation';

export async function readClipboardImage(): Promise<File> {
  if (native) {
    const content = parseFileContent(await invoke<unknown>('read_clipboard_image'));
    const blob = fileBlob(content);
    if (blob.size > MAX_FILE_BYTES) throw new Error('The clipboard image exceeds the 25 MB file limit.');
    if (describeFilePreview(content).kind !== 'image') throw new Error('There is no readable image on the clipboard. Copy an image first.');
    return new File([blob], content.name, { type: content.mimeType });
  }
  if (typeof navigator.clipboard?.read !== 'function') throw new Error('Use your device’s Paste command to add an image, or choose Add files.');
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = item.types.includes('image/png') ? 'image/png' : item.types.find(value => value.startsWith('image/'));
    if (type === undefined) continue;
    const blob = await item.getType(type);
    if (blob.size > MAX_FILE_BYTES) throw new Error('The clipboard image exceeds the 25 MB file limit.');
    const extension = type === 'image/jpeg' ? 'jpg' : type.split('/')[1] ?? 'png';
    return new File([blob], 'Clipboard image.' + extension, { type });
  }
  throw new Error('There is no readable image on the clipboard. Copy an image first.');
}

async function pngImage(content: FileContent): Promise<Blob> {
  const preview = describeFilePreview(content);
  if (preview.kind !== 'image') throw new Error('Only images can be copied to the clipboard.');
  const url = URL.createObjectURL(fileBlob({ ...content, mimeType: preview.mimeType }));
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('This image cannot be copied on this device. Try saving the file instead.'));
      image.src = url;
    });
    if (image.naturalWidth === 0 || image.naturalHeight === 0 || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('Choose an image smaller than 40 megapixels.');
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('The image could not be prepared for copying.');
    context.drawImage(image, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
      if (blob === null) reject(new Error('The image could not be prepared for copying.'));
      else resolve(blob);
    }, 'image/png'));
    if (png.size > MAX_FILE_BYTES) throw new Error('The image exceeds the 25 MB clipboard limit.');
    return png;
  } finally {
    image.onload = null;
    image.onerror = null;
    image.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
}

export async function copyImage(load: () => Promise<FileContent>): Promise<void> {
  if (native) {
    const png = await pngImage(await load());
    const content = await readSelectedFile(new File([png], 'Clipboard image.png', { type: 'image/png' }));
    await invoke<unknown>('write_clipboard_image', { dataBase64: content.dataBase64 });
    return;
  }
  if (typeof navigator.clipboard?.write !== 'function' || typeof ClipboardItem === 'undefined') throw new Error('Image copying is unavailable here. Save the file instead.');
  // Start the clipboard write inside the click gesture, including on WebKit;
  // reading/decoding the image is deferred through the ClipboardItem promise.
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': load().then(pngImage) })]);
}
