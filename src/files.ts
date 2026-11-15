import type { FileContent } from './types';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function readSelectedFile(file: File): Promise<FileContent> {
  if (file.size > MAX_FILE_BYTES) return Promise.reject(new Error('“' + file.name + '” exceeds the 25 MB file limit.'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read “' + file.name + '”. Please select it again.'));
    reader.onabort = () => reject(new Error('File import was cancelled.'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string' || !result.includes(',')) { reject(new Error('The selected file could not be read.')); return; }
      resolve({ name: file.name, mimeType: file.type.length > 0 ? file.type : 'application/octet-stream', dataBase64: result.slice(result.indexOf(',') + 1) });
    };
    reader.readAsDataURL(file);
  });
}

export function fileBlob(content: FileContent): Blob {
  const bytes = Uint8Array.from(atob(content.dataBase64), char => char.charCodeAt(0));
  return new Blob([bytes], { type: content.mimeType });
}

export async function imageThumbnail(content: FileContent): Promise<Blob> {
  const bitmap = await createImageBitmap(fileBlob(content), { resizeWidth: 400, resizeQuality: 'medium' });
  try {
    const scale = Math.min(1, 400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Image preview is unavailable.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => { if (blob === null) reject(new Error('Image preview is unavailable.')); else resolve(blob); }, 'image/webp', 0.8);
    });
  } finally { bitmap.close(); }
}

export function downloadPreviewFile(content: FileContent): void {
  const url = URL.createObjectURL(fileBlob(content));
  const link = document.createElement('a');
  link.href = url;
  link.download = content.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return bytes.toString() + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
