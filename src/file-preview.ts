import { fileBlob } from './files';
import { renderMarkdown } from './markdown';
import type { FileContent } from './types';

type PreviewKind = 'image' | 'audio' | 'video' | 'text' | 'markdown' | 'unsupported';
export interface FilePreview { kind: PreviewKind; mimeType: string }

const extensionTypes: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', aif: 'audio/aiff', aiff: 'audio/aiff',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp',
  txt: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values', log: 'text/plain',
  md: 'text/markdown', markdown: 'text/markdown', json: 'application/json',
  yaml: 'text/yaml', yml: 'text/yaml', xml: 'application/xml',
};

export function describeFilePreview(file: Pick<FileContent, 'name' | 'mimeType'>): FilePreview {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  let mimeType = file.mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  // Native share providers often omit the type even for common media files.
  if (['', 'application/octet-stream', 'binary/octet-stream', 'application/binary'].includes(mimeType)) {
    mimeType = extensionTypes[extension] ?? 'application/octet-stream';
  }
  if (mimeType === 'application/ogg') mimeType = extension === 'ogv' ? 'video/ogg' : 'audio/ogg';
  if (['audio/x-wav', 'audio/wave'].includes(mimeType)) mimeType = 'audio/wav';
  if (mimeType === 'audio/x-m4a') mimeType = 'audio/mp4';
  if (['text/markdown', 'text/x-markdown'].includes(mimeType) || (mimeType === 'text/plain' && ['md', 'markdown'].includes(extension))) return { kind: 'markdown', mimeType };
  if (['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif', 'image/bmp'].includes(mimeType)) return { kind: 'image', mimeType };
  if (mimeType.startsWith('audio/')) return { kind: 'audio', mimeType };
  if (mimeType.startsWith('video/')) return { kind: 'video', mimeType };
  if (mimeType.startsWith('text/') || ['application/json', 'application/xml', 'application/yaml'].includes(mimeType)) return { kind: 'text', mimeType };
  return { kind: 'unsupported', mimeType };
}

const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;

// Every preview owns its resources, including async text work. Closing or
// replacing the dialog releases media immediately and makes late results inert.
export function mountFilePreview(container: HTMLElement, content: FileContent, preview: FilePreview): () => void {
  const events = new AbortController();
  let disposed = false;
  let url: string | null = null;
  let media: HTMLMediaElement | null = null;
  const status = document.createElement('p');
  status.className = 'modal-copy file-preview-status';
  status.setAttribute('role', 'status');
  status.textContent = 'Loading preview…';
  container.replaceChildren(status);
  const loaded = () => { status.hidden = true; };
  const failed = () => {
    status.hidden = false;
    status.textContent = preview.kind === 'audio' || preview.kind === 'video'
      ? 'This ' + preview.kind + ' format cannot be played on this device. Save the file to open it in another app.'
      : 'This file could not be previewed. Save the file to open it in another app.';
  };
  const blob = fileBlob({ ...content, mimeType: preview.mimeType });
  if (preview.kind === 'text' || preview.kind === 'markdown') {
    void blob.slice(0, MAX_TEXT_PREVIEW_BYTES).text().then(source => {
      if (disposed) return;
      const body = document.createElement(preview.kind === 'markdown' ? 'div' : 'pre');
      body.className = preview.kind === 'markdown' ? 'file-text-preview markdown-content' : 'file-text-preview';
      body.tabIndex = 0;
      body.setAttribute('aria-label', content.name);
      if (preview.kind === 'markdown') body.innerHTML = renderMarkdown(source);
      else body.textContent = source;
      container.prepend(body);
      if (blob.size > MAX_TEXT_PREVIEW_BYTES) status.textContent = 'Showing the first 256 KB. Save the file to read the rest.';
      else loaded();
    }).catch(() => { if (!disposed) failed(); });
  } else if (preview.kind === 'image') {
    const image = document.createElement('img');
    image.className = 'full-image';
    image.alt = content.name;
    image.addEventListener('load', loaded, { signal: events.signal });
    image.addEventListener('error', failed, { signal: events.signal });
    url = URL.createObjectURL(blob);
    image.src = url;
    container.prepend(image);
  } else if (preview.kind === 'audio' || preview.kind === 'video') {
    const player = document.createElement(preview.kind);
    if (player instanceof HTMLVideoElement) player.playsInline = true;
    player.controls = true;
    player.preload = 'metadata';
    player.className = 'file-media-player';
    player.tabIndex = 0;
    player.setAttribute('aria-label', content.name);
    player.addEventListener('loadedmetadata', loaded, { signal: events.signal });
    player.addEventListener('error', failed, { signal: events.signal });
    url = URL.createObjectURL(blob);
    player.src = url;
    media = player;
    container.prepend(player);
  } else {
    status.textContent = 'Save a copy to open it in your preferred app.';
  }
  return () => {
    disposed = true;
    events.abort();
    if (media !== null) {
      media.pause();
      media.removeAttribute('src');
      media.load();
    }
    container.replaceChildren();
    if (url !== null) URL.revokeObjectURL(url);
  };
}
