import QRCode from 'qrcode';
import { api, native } from './bridge';
import { desktopCameraAvailable, scanDesktopInvitation } from './desktop-scanner';
import { mapCaret, rebaseDraft } from './rebase';
import type { DraftBackup, Note, PendingShare, Settings, SharedFile, Snapshot } from './types';
import { applyTheme } from './theme';
import { renderMarkdown } from './markdown';
import { downloadPreviewFile, fileSize, imageThumbnail, readSelectedFile } from './files';
import { describeFilePreview, mountFilePreview } from './file-preview';
import { copyImage, readClipboardImage } from './clipboard';
import { availableTags, filterFiles, filterNotes, normalizeTag } from './organization';
import { errorText, parseDraft, parseTheme, record, text } from './validation';
import { getDiscoveryError, initializeDiscovery } from '../native';
import './style.css';

function requiredDiv(selector: string): HTMLDivElement {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLDivElement)) throw new Error('Missing app container: ' + selector);
  return element;
}
const app = requiredDiv('#app');
const modalRoot = requiredDiv('#modal-root');
const toast = requiredDiv('#toast');
// Webview keyboards resize the visual viewport on iOS as well as Android.
function fitViewport() {
  const viewport = window.visualViewport;
  const height = Math.min(viewport?.height ?? window.innerHeight, window.innerHeight);
  document.documentElement.style.setProperty('--app-height', height.toString() + 'px');
  document.documentElement.style.setProperty('--viewport-top', (viewport?.offsetTop ?? 0).toString() + 'px');
  document.documentElement.classList.toggle('compact-height', height < 500);
  document.documentElement.classList.toggle('short-height', height < 300);
}
fitViewport();
window.visualViewport?.addEventListener('resize', fitViewport);
window.visualViewport?.addEventListener('scroll', fitViewport);
window.addEventListener('resize', fitViewport);
let snapshot: Snapshot = { network: null, notes: [], files: [], heads: [], status: { peers: 0, lastSync: null, error: null }, deviceId: '', listenerPort: 0 };
let started = false;
let recoveryPending = true;
let canScan = false;
let desktopScanController: AbortController | null = null;
let pendingShares: PendingShare[] = [];
let checkingShares = false;
let importingShares = false;
let shareFailureKey: string | null = null;
let shareReadError = '';
let shareListenerReady = false;
let incomingCheckTimer: ReturnType<typeof setTimeout> | undefined;
let section: 'notes' | 'files' | 'settings' = 'notes';
let settings: Settings = { theme: 'system' };
let fileBusy = false;
let fileToDelete: { id: string; networkId: string } | null = null;
const imageUrls = new Map<string, string>();
const loadingImages = new Set<string>();
const failedImages = new Set<string>();
let thumbnailQueue: Promise<void> = Promise.resolve();
let imageObserver: IntersectionObserver | null = null;
let imageGeneration = 0;
let filesSignature = '';
let modalGeneration = 0;
let filePreviewCleanup: (() => void) | null = null;
let activeFilePreview: { networkId: string; id: string } | null = null;
let draftWrites: Promise<void> = Promise.resolve();
let selected: string | null = null;
let mobileEditor = false;
let noteMode: 'write' | 'preview' = 'preview';
let noteQuery = '';
let noteTagFilter: string[] = [];
let fileTagFilter: string[] = [];
let tagFilterDialog: 'note' | 'file' | null = null;
let tagEditor: { kind: 'note' | 'file'; id: string; networkId: string } | null = null;
let actionBusy = false;
let mutation = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<boolean> | null = null;
let modalPreviousFocus: HTMLElement | null = null;
let scanning = false;
let scanCancelled = false;
let draft: { id: string; title: string; body: string; baseHeads: string[]; version: number; dirty: boolean } | null = null;

const paths: Record<string, string> = {
  files: '<path d="M3 7h7l2 2h9v11H3zM3 7V4h7l2 3"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m21 16-6-6L3 21"/>',
  audio: '<path d="M9 18V5l12-2v13M9 9l12-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="18" cy="16" rx="3" ry="3"/>',
  video: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m10 8 6 4-6 4z"/>',
  tag: '<path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="7.5" cy="7.5" r="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  scan: '<path d="M8 3H4a1 1 0 0 0-1 1v4m13-5h4a1 1 0 0 1 1 1v4M3 16v4a1 1 0 0 0 1 1h4m8 0h4a1 1 0 0 0 1-1v-4M3 12h18"/>',
  note: '<path d="M14 3H5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9zM14 3v6h6M8 13h8M8 17h5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  sync: '<path d="M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 13-2l2 2M4 17l2 2a8 8 0 0 0 13-2"/>',
  share: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><path d="M15 15h6v6h-6zM12 3v6M3 12h6m3 0h3m3 0h3M12 15v6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
};
const icon = (name: string, className = '') => `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths['note'] ?? ''}</svg>`;
const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value: string) => value.replace(/[&<>"']/g, c => entities[c] ?? c);
const noteTitle = (note: Pick<Note, 'title'>) => note.title.trim().length === 0 ? 'Untitled note' : note.title.trim();
const notePreview = (body: string) => body.trim().length === 0 ? 'Empty note' : body.trim().replace(/\s+/g, ' ').slice(0, 115);
const displayDate = (time: number) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(time < 1e12 ? time * 1000 : time);

function notify(message: string) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('visible');
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 6500);
}

function brand() {
  return '<a class="brand" href="#" aria-label="Murmur home"><img src="/identity.svg" width="35" height="35" alt=""/><span>murmur<span class="brand-period">.</span></span></a>';
}

function previewBanner() {
  return native ? '' : '<div class="preview-banner">Browser preview <span>·</span> Temporary demo; reload clears these notes, files, and settings.</div>';
}

function navigation() {
  return `<nav class="app-nav" aria-label="Main navigation"><button class="nav-button ${section === 'notes' ? 'active' : ''}" data-action="nav-notes" ${section === 'notes' ? 'aria-current="page"' : ''}>${icon('note')}<span>Notes</span></button><button class="nav-button ${section === 'files' ? 'active' : ''}" data-action="nav-files" ${section === 'files' ? 'aria-current="page"' : ''}>${icon('files')}<span>Files</span></button><button class="nav-button ${section === 'settings' ? 'active' : ''}" data-action="nav-settings" ${section === 'settings' ? 'aria-current="page"' : ''}>${icon('settings')}<span>Settings</span></button></nav>`;
}

function renderSettings() {
  return `<section class="settings-screen screen-scroll" aria-label="Settings"><header class="screen-heading"><div><h1>Settings</h1></div></header><section class="settings-card"><h2>Appearance</h2><div class="theme-choices" role="group" aria-label="Theme">${['system', 'light', 'dark'].map(theme => `<button class="theme-choice ${settings.theme === theme ? 'selected' : ''}" data-theme="${theme}" aria-pressed="${settings.theme === theme ? 'true' : 'false'}"><span class="theme-swatch swatch-${theme}" aria-hidden="true"></span>${theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark'}${settings.theme === theme ? icon('check') : ''}</button>`).join('')}</div></section>${snapshot.network === null ? '' : `<section class="settings-card"><h2>Network</h2><p class="network-name">${esc(snapshot.network.name)}</p><div id="sync-status"></div><button class="button secondary" data-action="network-menu">Manage network ${icon('arrow')}</button></section>`}</section>`;
}

function render() {
  imageObserver?.disconnect();
  if (snapshot.network === null && section !== 'settings') {
    app.innerHTML = `${previewBanner()}<div class="welcome-shell"><header class="topbar">${brand()}<button class="icon-button" data-action="nav-settings" aria-label="Settings">${icon('settings')}</button></header><main class="welcome"><div id="pending-share-status" class="pending-share-status" hidden></div><div class="welcome-actions"><button class="button primary" data-action="create-network">Create a network ${icon('plus')}</button><button class="button secondary" data-action="join-network">Join a network ${icon('scan')}</button></div></main></div>`;
    renderPendingShares();
    return;
  }
  const notesScreen = `<main class="workspace"><aside class="sidebar"><div class="sidebar-heading"><h1>Notes <span id="note-count">${snapshot.notes.length.toString()}</span></h1><button class="icon-button new-note-small" data-action="new-note" aria-label="New note">${icon('plus')}</button></div><div class="note-filters"><input id="note-search" type="search" aria-label="Search notes" placeholder="Search titles and text" value="${esc(noteQuery)}" autocomplete="off"/><div class="filter-row"><button id="note-tag-filter" class="tag-filter-button" data-action="filter-note-tags" aria-label="Filter notes by tag" aria-describedby="note-tag-selection" aria-haspopup="dialog" aria-expanded="false" aria-controls="tag-filter-picker"><span id="note-tag-selection">All tags</span>${icon('arrow')}</button><button class="icon-button" data-action="clear-note-filters" aria-label="Clear note filters">${icon('close')}</button></div></div><div id="note-list" class="note-list"></div></aside><section class="editor-panel" aria-label="Note editor"><div id="editor"></div></section></main>`;
  const filesScreen = `<section class="files-screen" aria-label="Shared files"><header class="screen-heading"><h1>Shared files <span id="file-count">${snapshot.files.length.toString()}</span></h1><div class="file-filters filter-row"><button id="file-tag-filter" class="tag-filter-button" data-action="filter-file-tags" aria-label="Filter files by tag" aria-describedby="file-tag-selection" aria-haspopup="dialog" aria-expanded="false" aria-controls="tag-filter-picker"><span id="file-tag-selection">All tags</span>${icon('arrow')}</button><button class="icon-button" data-action="clear-file-filters" aria-label="Clear file filters">${icon('close')}</button></div><div class="files-add-actions"><button class="button secondary" data-action="paste-image" title="Paste image" ${fileBusy ? 'disabled' : ''}>${icon('copy')}<span>Paste image</span></button><button class="button primary" data-action="add-files" title="Add files" ${fileBusy ? 'disabled' : ''}>${icon('plus')}<span>${fileBusy ? 'Adding…' : 'Add files'}</span></button></div><input id="file-picker" class="sr-only" type="file" multiple aria-label="Choose files"/></header><div id="file-grid" class="file-grid screen-scroll"></div></section>`;
  app.innerHTML = `${previewBanner()}<div data-section="${section}" class="notebook-shell ${section === 'notes' && mobileEditor ? 'editor-open' : ''}"><header class="topbar">${brand()}${snapshot.network === null ? '<button class="text-button" data-action="nav-notes">Back</button>' : ''}</header><div id="pending-share-status" class="pending-share-status" hidden></div>${section === 'notes' ? notesScreen : section === 'files' ? filesScreen : renderSettings()}${snapshot.network === null ? '' : navigation()}</div>`;
  filesSignature = '';
  renderPendingShares();
  renderList();
  renderEditor();
  renderFiles();
  renderStatus();
}

function renderPendingShares() {
  const status = document.querySelector('#pending-share-status');
  if (!(status instanceof HTMLElement)) return;
  status.hidden = pendingShares.length === 0;
  if (pendingShares.length === 0) { status.replaceChildren(); return; }
  const count = pendingShares.length.toString();
  const label = count + (pendingShares.length === 1 ? ' file ready to add' : ' files ready to add');
  status.innerHTML = `<span role="status">${importingShares ? 'Adding shared files…' : label}</span><div class="pending-share-actions">${snapshot.network === null ? '' : `<button class="text-button" data-action="import-shares" ${importingShares ? 'disabled' : ''}>${shareFailureKey === null ? 'Add now' : 'Retry import'}</button>`}<button class="text-button" data-action="discard-shares" ${importingShares ? 'disabled' : ''}>Discard</button></div>`;
}

function requestIncomingCheck(retry = false) {
  if (!native) return;
  if (retry) shareFailureKey = null;
  clearTimeout(incomingCheckTimer);
  incomingCheckTimer = setTimeout(() => void checkIncomingShares(), 0);
}

async function importIncomingShares(networkId: string, key: string) {
  if (!await flushSave()) { shareFailureKey = key; renderPendingShares(); return; }
  if (snapshot.network?.id !== networkId || recoveryPending || scanning || modalRoot.firstElementChild !== null) return;
  importingShares = true;
  renderPendingShares();
  const previous = new Set(snapshot.files.map(file => file.id));
  try {
    const result = await api.importShares(networkId);
    if (snapshot.network?.id !== networkId || result.network?.id !== networkId) return;
    snapshot = result;
    pendingShares = [];
    shareFailureKey = null;
    const count = snapshot.files.filter(file => !previous.has(file.id)).length;
    // Typing can continue while the native batch commits. Save those final
    // keystrokes too before replacing the editor with the Files screen.
    if (!await flushSave()) { renderPendingShares(); renderList(); return; }
    if (snapshot.network?.id !== networkId) return;
    section = 'files';
    mobileEditor = false;
    render();
    if (count > 0) notify(count.toString() + (count === 1 ? ' file added.' : ' files added.'));
  } catch (error) {
    shareFailureKey = key;
    notify('Could not add shared files: ' + errorText(error));
  } finally {
    importingShares = false;
    renderPendingShares();
  }
}

async function checkIncomingShares() {
  if (!native || !started || document.hidden || checkingShares) return;
  checkingShares = true;
  try {
    pendingShares = await api.pendingShares();
    shareReadError = '';
    renderPendingShares();
    const network = snapshot.network;
    if (pendingShares.length === 0 || network === null || recoveryPending || actionBusy || saving !== null || scanning || modalRoot.firstElementChild !== null) return;
    const key = network.id + ':' + pendingShares.map(file => file.id).join(',');
    if (shareFailureKey === key) return;
    await perform(() => importIncomingShares(network.id, key));
  } catch (error) {
    const message = errorText(error);
    if (message !== shareReadError) notify('Could not check shared files: ' + message);
    shareReadError = message;
  } finally { checkingShares = false; }
}

function canPreviewImage(file: SharedFile) {
  return describeFilePreview(file).kind === 'image';
}

function tagChips(tags: string[]): string {
  return tags.map(tag => `<span class="tag-chip">${esc(tag)}</span>`).join('');
}

function renderTagFilter(kind: 'note' | 'file') {
  const button = document.querySelector(kind === 'note' ? '#note-tag-filter' : '#file-tag-filter');
  if (!(button instanceof HTMLButtonElement)) return;
  const current = kind === 'note' ? noteTagFilter : fileTagFilter;
  const label = current.length === 0 ? 'All tags' : current.join(', ');
  const summary = button.querySelector('span');
  if (summary !== null) summary.textContent = label;
  button.title = label;
  button.classList.toggle('has-selected-tags', current.length > 0);
  const clear = document.querySelector(kind === 'note' ? '[data-action="clear-note-filters"]' : '[data-action="clear-file-filters"]');
  if (clear instanceof HTMLButtonElement) clear.disabled = current.length === 0 && (kind === 'file' || noteQuery.length === 0);
  if (tagFilterDialog === kind) renderTagFilterChoices();
}

function renderTagFilterChoices() {
  const kind = tagFilterDialog;
  const list = modalRoot.querySelector('#tag-filter-choices');
  if (kind === null || !(list instanceof HTMLElement)) return;
  const current = kind === 'note' ? noteTagFilter : fileTagFilter;
  const tags = availableTags(kind === 'note' ? snapshot.notes : snapshot.files);
  // Keep selected tags visible after peers remove them so they can be cleared.
  for (const tag of current) if (!tags.includes(tag)) tags.push(tag);
  const signature = JSON.stringify(tags);
  if (list.dataset['tags'] !== signature) {
    const focused = document.activeElement;
    const focusedTag = focused instanceof HTMLButtonElement && list.contains(focused) ? focused.value : null;
    list.innerHTML = tags.length === 0 ? '<p class="tag-filter-empty">No tags</p>' : tags.map(tag => `<button type="button" class="tag-filter-choice" role="checkbox" aria-checked="${current.includes(tag) ? 'true' : 'false'}" data-filter-tag="${kind}" value="${esc(tag)}">${icon('tag')}<span>${esc(tag)}</span><span class="tag-filter-check">${icon('check')}</span></button>`).join('');
    list.dataset['tags'] = signature;
    if (focusedTag !== null) {
      const replacement = [...list.querySelectorAll('button')].find(button => button.value === focusedTag);
      const fallback = modalRoot.querySelector('.tag-filter-close');
      if (replacement !== undefined) replacement.focus();
      else if (fallback instanceof HTMLElement) fallback.focus();
    }
  }
  for (const choice of list.querySelectorAll('button')) choice.setAttribute('aria-checked', current.includes(choice.value) ? 'true' : 'false');
  const clear = modalRoot.querySelector('[data-action="clear-selected-tags"]');
  if (clear instanceof HTMLButtonElement) clear.disabled = current.length === 0;
  positionTagFilter();
}

function positionTagFilter() {
  if (tagFilterDialog === null) return;
  const trigger = document.querySelector(tagFilterDialog === 'note' ? '#note-tag-filter' : '#file-tag-filter');
  const picker = modalRoot.querySelector('.tag-filter-popover');
  if (!(trigger instanceof HTMLElement) || !(picker instanceof HTMLElement)) return;
  const anchor = trigger.getBoundingClientRect();
  const viewport = window.visualViewport;
  const leftEdge = (viewport?.offsetLeft ?? 0) + 12;
  const topEdge = (viewport?.offsetTop ?? 0) + 12;
  const rightEdge = leftEdge + (viewport?.width ?? innerWidth) - 24;
  const bottomEdge = topEdge + Math.min(viewport?.height ?? innerHeight, innerHeight) - 24;
  const width = Math.min(Math.max(anchor.width, 240), 320, rightEdge - leftEdge);
  const below = bottomEdge - anchor.bottom - 6;
  const above = anchor.top - topEdge - 6;
  const opensAbove = below < 200 && above > below;
  const useViewport = Math.max(above, below) < 120;
  picker.style.width = width.toString() + 'px';
  picker.style.left = Math.max(leftEdge, Math.min(anchor.left, rightEdge - width)).toString() + 'px';
  picker.style.maxHeight = Math.max(44, Math.min(360, useViewport ? bottomEdge - topEdge : opensAbove ? above : below)).toString() + 'px';
  const height = picker.getBoundingClientRect().height;
  picker.style.top = (useViewport ? topEdge : Math.max(topEdge, Math.min(opensAbove ? anchor.top - height - 6 : anchor.bottom + 6, bottomEdge - height))).toString() + 'px';
}

function openTagFilter(kind: 'note' | 'file') {
  if (tagFilterDialog === kind) { closeModal(); return; }
  const trigger = document.querySelector(kind === 'note' ? '#note-tag-filter' : '#file-tag-filter');
  openModal('<header class="tag-filter-heading"><h2>Tags</h2><button class="text-button" data-action="clear-selected-tags">Clear tags</button><button class="icon-button tag-filter-close" data-action="close-modal" aria-label="Close dialog">' + icon('close') + '</button></header><div id="tag-filter-choices" class="tag-filter-choices"></div>', kind === 'note' ? 'Filter notes by tag' : 'Filter files by tag');
  tagFilterDialog = kind;
  const layer = modalRoot.firstElementChild;
  const picker = modalRoot.querySelector('.modal');
  if (layer instanceof HTMLElement) layer.className = 'tag-filter-layer';
  if (picker instanceof HTMLElement) {
    picker.className = 'tag-filter-popover';
    picker.id = 'tag-filter-picker';
    picker.setAttribute('aria-modal', 'false');
    picker.querySelector('.modal-close')?.remove();
  }
  app.inert = recoveryPending;
  if (trigger instanceof HTMLElement) {
    modalPreviousFocus = trigger;
    trigger.setAttribute('aria-expanded', 'true');
  }
  renderTagFilterChoices();
}

function renderNoteTags() {
  const summary = document.querySelector('#note-tag-summary');
  const note = snapshot.notes.find(entry => entry.id === draft?.id);
  if (summary instanceof HTMLElement) {
    const tags = note?.tags ?? [];
    summary.hidden = tags.length === 0;
    const markup = tagChips(tags);
    if (summary.innerHTML !== markup) summary.innerHTML = markup;
  }
  const edit = document.querySelector('[data-action="edit-note-tags"]');
  if (edit instanceof HTMLButtonElement) edit.disabled = note === undefined;
}

function editingTags(): string[] | undefined {
  if (tagEditor === null || tagEditor.networkId !== snapshot.network?.id) return undefined;
  const entries = tagEditor.kind === 'note' ? snapshot.notes : snapshot.files;
  return entries.find(entry => entry.id === tagEditor?.id)?.tags;
}

function renderTagEditor() {
  if (tagEditor === null) return;
  const tags = editingTags();
  if (tags === undefined) { closeModal(); notify('This item is no longer available in this network.'); return; }
  const list = modalRoot.querySelector('#editing-tags');
  if (!(list instanceof HTMLElement)) return;
  const markup = tags.length === 0 ? '<p class="modal-fine">No tags yet.</p>' : tags.map(tag => `<button class="tag-chip tag-remove" data-remove-tag="${esc(tag)}" aria-label="${esc('Remove tag ' + tag)}">${esc(tag)}${icon('close')}</button>`).join('');
  if (list.innerHTML !== markup) {
    const hadFocus = list.contains(document.activeElement);
    list.innerHTML = markup;
    if (hadFocus) {
      const field = modalRoot.querySelector('#tag-name');
      if (field instanceof HTMLInputElement) field.focus();
    }
  }
  renderTagSuggestions();
}

function renderTagSuggestions() {
  const tags = editingTags();
  const suggestions = modalRoot.querySelector('#tag-suggestions');
  const field = modalRoot.querySelector('#tag-name');
  if (tags === undefined || !(suggestions instanceof HTMLElement) || !(field instanceof HTMLInputElement)) return;
  const query = field.value.trim().toLowerCase();
  const options = availableTags([...snapshot.notes, ...snapshot.files]).filter(tag => !tags.includes(tag) && tag.toLowerCase().includes(query));
  const markup = options.map(tag => `<button type="button" class="tag-chip tag-suggestion" data-add-tag="${esc(tag)}" aria-label="${esc('Add tag ' + tag)}">${icon('plus')}<span>${esc(tag)}</span></button>`).join('');
  if (suggestions.innerHTML !== markup) {
    const focused = document.activeElement;
    const focusedTag = focused instanceof HTMLButtonElement && suggestions.contains(focused) ? focused.getAttribute('data-add-tag') : null;
    suggestions.innerHTML = markup;
    if (focusedTag !== null) {
      const replacement = [...suggestions.querySelectorAll('button')].find(button => button.getAttribute('data-add-tag') === focusedTag);
      if (replacement !== undefined) replacement.focus();
      else field.focus();
    }
  }
  suggestions.hidden = options.length === 0;
}

async function editTags(kind: 'note' | 'file', id: string) {
  if (!await flushSave()) return;
  const networkId = snapshot.network?.id;
  const entry = kind === 'note' ? snapshot.notes.find(note => note.id === id) : snapshot.files.find(file => file.id === id);
  if (networkId === undefined || entry === undefined) return;
  const name = 'title' in entry ? noteTitle(entry) : entry.name;
  openModal(`<h2>Tags</h2><p class="modal-copy">${esc(name)}</p><div id="editing-tags" class="editing-tags"></div><form id="tag-form"><label for="tag-name">Tag name</label><input id="tag-name" name="tag" placeholder="e.g. music" autocomplete="off" required autofocus/><div id="tag-suggestions" class="tag-suggestions" role="group" aria-label="Suggested tags" hidden></div><button class="button primary full-width" type="submit">${icon('plus')} Add tag</button></form>`, 'Edit tags');
  tagEditor = { kind, id, networkId };
  renderTagEditor();
}

async function changeTag(raw: string, present: boolean) {
  const editor = tagEditor;
  if (editor === null || editingTags() === undefined || !await flushSave()) return;
  const tag = normalizeTag(raw);
  const epoch = mutation;
  let next = await api.setTag(editor.networkId, editor.kind, editor.id, tag, present);
  if (snapshot.network?.id !== editor.networkId) return;
  // Closing the dialog allows typing again while a native tag write finishes.
  // An older response must never replace text saved during that time.
  if (epoch !== mutation) {
    if (saving !== null) await saving;
    const freshEpoch = mutation;
    next = await api.snapshot();
    if (freshEpoch !== mutation || snapshot.network?.id !== editor.networkId) return;
  }
  if (next.network?.id !== editor.networkId) return;
  snapshot = next;
  updateDraftFromSnapshot();
  renderList();
  renderFiles();
  renderStatus();
  if (tagEditor === editor) {
    renderTagEditor();
    const field = modalRoot.querySelector('#tag-name');
    if (field instanceof HTMLInputElement) { if (present) field.value = ''; field.focus(); }
    renderTagSuggestions();
  }
}

function resetImages() {
  imageGeneration++;
  for (const url of imageUrls.values()) URL.revokeObjectURL(url);
  imageUrls.clear();
  loadingImages.clear();
  failedImages.clear();
}

function patchThumbnail(id: string, url: string | null) {
  const card = [...document.querySelectorAll('[data-file-card]')].find(element => element.getAttribute('data-file-card') === id);
  const button = card?.querySelector('.file-preview');
  if (!(button instanceof HTMLButtonElement)) return;
  const existing = button.querySelector('img');
  if (url === null) {
    existing?.remove();
    if (button.querySelector('svg') === null) button.insertAdjacentHTML('afterbegin', icon('image'));
    return;
  }
  if (existing instanceof HTMLImageElement) { existing.src = url; return; }
  const image = document.createElement('img');
  image.src = url;
  image.alt = '';
  image.loading = 'lazy';
  button.querySelector('svg')?.remove();
  button.prepend(image);
}

function renderFiles() {
  renderTagFilter('file');
  renderTagEditor();
  if (activeFilePreview !== null && (activeFilePreview.networkId !== snapshot.network?.id || !snapshot.files.some(file => file.id === activeFilePreview?.id && file.available))) {
    closeModal();
    notify('This file is no longer available in this network.');
  }
  const grid = document.querySelector('#file-grid');
  if (grid === null) return;
  const signature = JSON.stringify([snapshot.files, fileTagFilter]);
  if (signature === filesSignature) return;
  filesSignature = signature;
  const count = document.querySelector('#file-count');
  const visibleFiles = filterFiles(snapshot.files, fileTagFilter);
  if (count !== null) count.textContent = visibleFiles.length === snapshot.files.length ? snapshot.files.length.toString() : visibleFiles.length.toString() + '/' + snapshot.files.length.toString();
  for (const [id, url] of imageUrls) {
    if (!snapshot.files.some(file => file.id === id)) { URL.revokeObjectURL(url); imageUrls.delete(id); }
  }
  grid.innerHTML = snapshot.files.length === 0 ? `<div class="files-empty"><div class="empty-mark">${icon('files')}</div><h2>No files yet</h2><button class="button secondary" data-action="add-files">${icon('plus')} Add your first file</button></div>` : visibleFiles.length === 0 ? '<div class="files-empty"><h2>No matching files</h2><p>Try another tag or clear the filter.</p></div>' : [...visibleFiles].sort((a, b) => b.createdAt - a.createdAt).map(file => {
    const url = imageUrls.get(file.id);
    const kind = describeFilePreview(file).kind;
    return `<article class="file-card" data-file-card="${esc(file.id)}"><button class="file-preview" data-open-file="${esc(file.id)}" aria-label="${esc((canPreviewImage(file) ? 'Preview ' : 'View ') + file.name)}" ${file.available ? '' : 'disabled'}>${url === undefined ? icon(kind === 'image' || kind === 'audio' || kind === 'video' ? kind : 'note') : `<img src="${esc(url)}" alt="" loading="lazy"/>`}<span class="file-type">${esc(file.name.split('.').pop()?.toUpperCase().slice(0, 8) ?? 'FILE')}</span></button><div class="file-info"><h2 title="${esc(file.name)}">${esc(file.name)}</h2><p>${fileSize(file.size)} <span>·</span> ${displayDate(file.createdAt)}</p>${file.tags.length === 0 ? '' : `<div class="file-card-tags">${tagChips(file.tags)}</div>`}<span class="file-availability ${file.available ? '' : 'pending'}">${icon(file.available ? 'check' : 'sync')}${file.available ? native ? 'Saved on device' : 'In this session' : 'Waiting for a nearby device'}</span></div><button class="text-button file-tags-button" data-edit-file-tags="${esc(file.id)}" aria-label="${esc('Edit tags for ' + file.name)}">${icon('tag')} Tags</button><div class="file-actions"><button class="text-button" data-save-file="${esc(file.id)}" ${file.available ? '' : 'disabled'}>${icon('download')} Save file</button><button class="icon-button" data-delete-file="${esc(file.id)}" aria-label="${esc('Delete ' + file.name)}">${icon('trash')}</button></div></article>`;
  }).join('');
  imageObserver?.disconnect();
  imageObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const id = entry.target.getAttribute('data-file-card');
      const file = snapshot.files.find(item => item.id === id);
      if (file === undefined || !file.available || !canPreviewImage(file) || imageUrls.has(file.id) || loadingImages.has(file.id) || failedImages.has(file.id)) continue;
      const generation = imageGeneration;
      const networkId = snapshot.network?.id;
      if (networkId === undefined) continue;
      loadingImages.add(file.id);
      // Decode one image at a time and retain only small thumbnails. A grid of
      // high-resolution photos must not retain every original file in memory.
      thumbnailQueue = thumbnailQueue.then(async () => {
        if (generation !== imageGeneration || section !== 'files') return;
        const content = await api.readFile(networkId, file.id);
        if (generation !== imageGeneration || section !== 'files') return;
        const thumbnail = await imageThumbnail(content);
        if (generation !== imageGeneration || !snapshot.files.some(current => current.id === file.id)) return;
        const url = URL.createObjectURL(thumbnail);
        imageUrls.set(file.id, url);
        patchThumbnail(file.id, url);
        if (imageUrls.size > 64) {
          const oldest = imageUrls.entries().next().value;
          if (oldest !== undefined) { URL.revokeObjectURL(oldest[1]); imageUrls.delete(oldest[0]); patchThumbnail(oldest[0], null); }
        }
      }).catch(() => { failedImages.add(file.id); }).finally(() => loadingImages.delete(file.id));
    }
  }, { root: grid, rootMargin: '120px' });
  for (const card of grid.querySelectorAll('[data-file-card]')) imageObserver.observe(card);
}

async function openFile(id: string) {
  const networkId = snapshot.network?.id;
  if (networkId === undefined) return;
  const file = snapshot.files.find(entry => entry.id === id);
  if (file === undefined || !file.available) return;
  const preview = describeFilePreview(file);
  openModal(`<h2 class="file-dialog-name">${esc(file.name)}</h2><div id="file-preview-content"><p class="modal-copy file-preview-status" role="status">${preview.kind === 'unsupported' ? 'Save a copy to open it in your preferred app.' : 'Loading preview…'}</p></div><p class="modal-copy">${fileSize(file.size)} · ${esc(preview.mimeType)}</p><div class="modal-actions">${preview.kind === 'image' ? `<button class="button secondary" data-copy-file="${esc(id)}">${icon('copy')} Copy image</button>` : ''}<button class="button primary full-width" data-save-file="${esc(id)}">${icon('download')} Save file</button></div>`, 'Shared file');
  modalRoot.querySelector('.modal')?.classList.add('file-modal');
  activeFilePreview = { networkId, id };
  const generation = modalGeneration;
  const container = modalRoot.querySelector('#file-preview-content');
  if (!(container instanceof HTMLElement) || preview.kind === 'unsupported') return;
  try {
    const content = await api.readFile(networkId, id);
    if (generation !== modalGeneration || snapshot.network?.id !== networkId || !snapshot.files.some(entry => entry.id === id && entry.available)) return;
    filePreviewCleanup = mountFilePreview(container, content, preview);
  } catch (error) {
    if (generation !== modalGeneration) return;
    const status = container.querySelector('.file-preview-status');
    if (status !== null) status.textContent = 'Could not load this preview. ' + errorText(error);
  }
}

async function saveFile(id: string) {
  const networkId = snapshot.network?.id;
  if (networkId === undefined) return;
  const content = await api.readFile(networkId, id);
  if (snapshot.network?.id !== networkId) return;
  if (native) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({ defaultPath: content.name });
    if (path === null) return;
    await writeFile(path, Uint8Array.from(atob(content.dataBase64), char => char.charCodeAt(0)));
    notify('File saved. Open it from your device’s files app.');
  } else {
    downloadPreviewFile(content);
    notify('File ready to save.');
  }
}

async function copyFileImage(id: string) {
  const networkId = snapshot.network?.id;
  const file = snapshot.files.find(entry => entry.id === id);
  if (networkId === undefined || file === undefined || !file.available || !canPreviewImage(file)) return;
  await copyImage(async () => {
    const content = await api.readFile(networkId, id);
    if (snapshot.network?.id !== networkId || !snapshot.files.some(entry => entry.id === id)) throw new Error('This file is no longer available in this network.');
    return content;
  });
  notify('Image copied. Paste it into another app.');
}

async function importFiles(networkId: string, files: File[]) {
  if (fileBusy) return;
  fileBusy = true;
  render();
  let imported = 0;
  const failures: string[] = [];
  try {
    for (const file of files) {
      try {
        const content = await readSelectedFile(file);
        const result = await api.importFile(networkId, content);
        if (snapshot.network?.id !== networkId) throw new Error('The active network changed. Return to the original network to see your files.');
        snapshot = result; imported++; renderFiles();
      }
      catch (error) { failures.push(errorText(error)); }
    }
  } finally { fileBusy = false; render(); }
  if (failures.length > 0) notify((imported > 0 ? imported.toString() + ' added. ' : '') + failures.join(' '));
  else notify(imported.toString() + (imported === 1 ? ' file added. ' : ' files added. ') + 'Other devices receive them when nearby.');
}

function renderList() {
  renderTagFilter('note');
  renderNoteTags();
  renderTagEditor();
  const list = document.querySelector('#note-list');
  if (list === null) return;
  const count = document.querySelector('#note-count');
  const currentNotes = snapshot.notes.map(note => note.id === draft?.id ? { ...note, title: draft.title, body: draft.body } : note);
  const notes = filterNotes(currentNotes, noteQuery, noteTagFilter).sort((a, b) => b.updatedAt - a.updatedAt);
  if (count !== null) count.textContent = notes.length === snapshot.notes.length ? snapshot.notes.length.toString() : notes.length.toString() + '/' + snapshot.notes.length.toString();
  list.innerHTML = notes.length > 0 ? notes.map(note => {
    const value = draft?.id === note.id ? draft : note;
    return `<button class="note-card ${selected === note.id ? 'active' : ''}" data-note="${esc(note.id)}" ${selected === note.id ? 'aria-current="true"' : ''}><span class="note-card-title">${esc(noteTitle(value))}</span><span class="note-card-preview">${esc(notePreview(value.body))}</span>${note.tags.length === 0 ? '' : `<span class="note-card-tags">${tagChips(note.tags)}</span>`}<span class="note-card-date">${displayDate(note.updatedAt)}<span class="note-card-arrow">${icon('arrow')}</span></span></button>`;
  }).join('') : `<div class="list-empty">${snapshot.notes.length === 0 ? 'No notes yet' : 'No matching notes. Try another search or tag.'}</div>`;
}

function renderEditor() {
  const editor = document.querySelector('#editor');
  if (editor === null) return;
  if (draft === null) {
    editor.innerHTML = `<div class="editor-empty"><div class="empty-mark">${icon('note')}</div><h2>No note selected</h2><button class="button secondary" data-action="new-note">${icon('plus')} Create note</button></div>`;
    return;
  }
  noteMode = 'preview';
  editor.innerHTML = `<div class="editor-toolbar"><button class="text-button back-notes" data-action="back">${icon('back')} Notes</button><span class="editor-label">${icon('note')} Note</span><div class="editor-tools">${snapshot.notes.some(note => note.id === draft?.id) ? '' : '<button class="text-button" data-action="copy-recovered">Copy recovered text</button>'}<button id="save-state" class="save-state" aria-live="polite" type="button"></button><button class="icon-button edit-note-tags" data-action="edit-note-tags" aria-label="Edit note tags">${icon('tag')}</button><button class="icon-button delete-note" data-action="delete-note" aria-label="Delete this note">${icon('trash')}</button></div></div><div class="writing-area"><div class="note-heading"><input id="note-title" class="note-title" aria-label="Note title" placeholder="Untitled note" maxlength="256" autocomplete="off" value="${esc(draft.title)}"/></div><div id="note-tag-summary" class="note-tag-summary"></div><textarea id="note-body" class="note-body" aria-label="Note text" spellcheck="true" hidden>${esc(draft.body)}</textarea><div id="note-markdown-preview" class="note-markdown-preview markdown-content" role="region" aria-label="Markdown preview" tabindex="0"></div></div><div class="editor-bottom"><span id="word-count"></span></div>`;
  renderSaveState();
  renderNoteTags();
  updateWordCount();
}

function renderStatus() {
  const status = document.querySelector('#sync-status');
  if (status === null) return;
  const connected = snapshot.status.peers > 0;
  const error = snapshot.status.error ?? getDiscoveryError();
  status.innerHTML = `<div class="connection-line"><span class="status-dot ${connected ? '' : 'idle'}"></span><strong>${connected ? `${snapshot.status.peers.toString()} nearby ${snapshot.status.peers === 1 ? 'device' : 'devices'}` : 'Ready for nearby devices'}</strong><button class="icon-button sync-button" data-action="sync" aria-label="Retry synchronization">${icon('sync')}</button></div><p class="connection-copy">${error.length > 0 ? esc(error) : connected ? 'Notes and files sync automatically.' : 'Open Murmur on the same Wi-Fi to sync.'}</p>`;
}

function renderSaveState(message?: string, failed = false) {
  const label = document.querySelector('#save-state');
  if (label === null) return;
  label.className = `save-state ${failed ? 'save-failed' : ''}`;
  label.innerHTML = message !== undefined ? esc(message) : draft?.dirty === true ? 'Saving…' : `${icon('check')} ${native ? 'Saved on device' : 'Saved for this session'}`;
}

function updateWordCount() {
  const words = draft?.body.trim().split(/\s+/).filter(word => word.length > 0).length ?? 0;
  const label = document.querySelector('#word-count');
  if (label !== null) label.textContent = `${words.toString()} ${words === 1 ? 'word' : 'words'}`;
  renderNotePreview();
}

function renderNotePreview() {
  const preview = document.querySelector('#note-markdown-preview');
  if (!(preview instanceof HTMLElement) || draft === null || noteMode !== 'preview') return;
  // Polling must preserve scroll position and selections when content is unchanged.
  if (preview.dataset['source'] === draft.body) return;
  preview.dataset['source'] = draft.body;
  preview.innerHTML = renderMarkdown(draft.body);
}

function setNoteMode(mode: 'write' | 'preview') {
  noteMode = mode;
  const body = document.querySelector('#note-body');
  const preview = document.querySelector('#note-markdown-preview');
  if (body instanceof HTMLElement) body.hidden = mode !== 'write';
  if (preview instanceof HTMLElement) preview.hidden = mode !== 'preview';
  renderNotePreview();
}

function queueDraftWrite(operation: () => Promise<void>): Promise<void> {
  const pending = draftWrites.catch(() => undefined).then(operation);
  draftWrites = pending;
  return pending;
}

function backupDraft(): Promise<void> {
  const current = draft;
  const network = snapshot.network;
  if (current === null || network === null) return Promise.resolve();
  if (current.dirty) {
    const backup: DraftBackup = { networkId: network.id, id: current.id, title: current.title, body: current.body, baseHeads: [...current.baseHeads] };
    return queueDraftWrite(() => api.saveDraft(backup));
  }
  return queueDraftWrite(() => api.clearDraft(network.id, current.id));
}

function scheduleBackup() {
  void backupDraft().catch((error: unknown) => {
    renderSaveState('Draft backup failed · keep this app open', true);
    notify('Could not back up your latest typing: ' + errorText(error));
  });
}

async function recoverDraft() {
  // Read the old webview backup only to migrate it into SQLite. Delete it only
  // after the database has committed; a failed migration leaves it recoverable.
  if (native) {
    try {
      const stored = localStorage.getItem('murmur-unsaved-draft');
      if (stored !== null) {
        const decoded: unknown = JSON.parse(stored);
        const legacy = parseDraft(decoded);
        await api.importDraft(legacy);
        localStorage.removeItem('murmur-unsaved-draft');
      }
    } catch (error) {
      notify('An older draft could not be migrated; its backup is still intact. ' + errorText(error));
    }
  }
  const recovered = await api.getDraft();
  if (recovered !== null && recovered.networkId === snapshot.network?.id) {
    draft = { id: recovered.id, title: recovered.title, body: recovered.body, baseHeads: recovered.baseHeads, version: 1, dirty: true };
    selected = draft.id;
    mobileEditor = true;
    render();
    if (snapshot.notes.some(note => note.id === recovered.id)) {
      notify('Recovered your last unsaved draft.');
      void flushSave();
    } else {
      notify('The original note was deleted. Copy your recovered text before discarding this draft.');
      renderSaveState('Original note deleted · draft recovered', true);
    }
  }
}

function setFieldValue(id: string, value: string) {
  const field = document.querySelector(id);
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) || field.value === value) return;
  const before = field.value;
  const start = field.selectionStart ?? 0;
  const end = field.selectionEnd ?? start;
  field.value = value;
  if (document.activeElement === field) field.setSelectionRange(mapCaret(before, value, start), mapCaret(before, value, end));
}

function updateDraftFromSnapshot() {
  const current = draft;
  if (current === null || current.dirty || saving !== null) return;
  const note = snapshot.notes.find(n => n.id === current.id);
  if (note === undefined) {
    draft = null;
    selected = null;
    mobileEditor = false;
    render();
    notify('This note was deleted by another device.');
    return;
  }
  current.title = note.title;
  current.body = note.body;
  current.baseHeads = snapshot.heads;
  setFieldValue('#note-title', note.title);
  setFieldValue('#note-body', note.body);
  updateWordCount();
}

async function flushSave(): Promise<boolean> {
  clearTimeout(saveTimer);
  if (saving !== null) {
    const ok = await saving;
    return ok && draft?.dirty === true ? flushSave() : ok;
  }
  if (draft === null || !draft.dirty) return true;
  const sent = { ...draft, baseHeads: [...draft.baseHeads] };
  mutation++;
  const operation = (async () => {
    try {
      // A failed backup must be retryable without another keystroke. Requeue
      // the current text before saving, replacing any previously rejected tail.
      await backupDraft();
      const result = await api.updateNote(sent.id, sent.title, sent.body, sent.baseHeads);
      snapshot = result;
      const note = result.notes.find(n => n.id === sent.id);
      if (note === undefined) throw new Error('This note was deleted on another device. Your draft is still here to copy.');
      if (draft?.id === sent.id) {
        const hasMoreInput = draft.version !== sent.version;
        draft.title = hasMoreInput ? rebaseDraft(sent.title, draft.title, note.title) : note.title;
        draft.body = hasMoreInput ? rebaseDraft(sent.body, draft.body, note.body) : note.body;
        draft.baseHeads = result.heads;
        draft.dirty = draft.title !== note.title || draft.body !== note.body;
        setFieldValue('#note-title', draft.title);
        setFieldValue('#note-body', draft.body);
        await backupDraft();
      }
      renderList();
      renderSaveState();
      renderStatus();
      updateWordCount();
      return true;
    } catch (error) {
      // If the note committed but recovery cleanup failed, retry from the
      // returned heads already assigned above, never from the old revision.
      if (draft?.id === sent.id) draft.dirty = true;
      renderSaveState('Not saved · tap to retry', true);
      notify(`Couldn't save: ${errorText(error)}`);
      return false;
    } finally {
      mutation++;
      saving = null;
    }
  })();
  saving = operation;
  const ok = await operation;
  if (ok && draft?.dirty === true) return flushSave();
  return ok;
}

async function selectNote(id: string) {
  if (!await flushSave()) return;
  const note = snapshot.notes.find(n => n.id === id);
  if (note === undefined) return;
  selected = id;
  draft = { ...note, baseHeads: snapshot.heads, version: 0, dirty: false };
  mobileEditor = true;
  render();
}

async function perform(action: () => Promise<void>) {
  if (actionBusy) return;
  actionBusy = true;
  mutation++;
  try { await action(); }
  catch (error) { notify(errorText(error)); }
  finally { actionBusy = false; mutation++; if (pendingShares.length > 0) requestIncomingCheck(); }
}

function openModal(content: string, label: string) {
  tagEditor = null;
  tagFilterDialog = null;
  modalGeneration++;
  const generation = modalGeneration;
  filePreviewCleanup?.();
  filePreviewCleanup = null;
  activeFilePreview = null;
  if (modalRoot.firstElementChild === null) modalPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(label)}"><button class="icon-button modal-close" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button>${content}</section></div>`;
  app.inert = true;
  setTimeout(() => {
    // Initial focus must not override user input or a replacement dialog.
    if (generation !== modalGeneration || modalRoot.contains(document.activeElement)) return;
    const field = tagFilterDialog === null
      ? modalRoot.querySelector('[autofocus], input:not(:disabled), textarea:not(:disabled), [tabindex="0"], button:not(.modal-close):not(:disabled)')
      : modalRoot.querySelector('.tag-filter-choice') ?? modalRoot.querySelector('.tag-filter-close');
    if (field instanceof HTMLElement) field.focus();
  }, 30);
}

function closeModal(restoreFocus = true) {
  if (tagFilterDialog !== null) document.querySelector(tagFilterDialog === 'note' ? '#note-tag-filter' : '#file-tag-filter')?.setAttribute('aria-expanded', 'false');
  tagFilterDialog = null;
  const closingTagEditor = tagEditor;
  tagEditor = null;
  modalGeneration++;
  filePreviewCleanup?.();
  filePreviewCleanup = null;
  activeFilePreview = null;
  if (modalRoot.firstElementChild === null) return;
  modalRoot.innerHTML = '';
  app.inert = recoveryPending;
  if (restoreFocus && modalPreviousFocus?.isConnected === true) modalPreviousFocus.focus();
  else if (restoreFocus && closingTagEditor !== null) {
    const target = closingTagEditor.kind === 'file'
      ? [...document.querySelectorAll('[data-edit-file-tags]')].find(element => element.getAttribute('data-edit-file-tags') === closingTagEditor.id) ?? document.querySelector('#file-tag-filter')
      : document.querySelector('[data-action="edit-note-tags"]') ?? document.querySelector('#note-search');
    if (target instanceof HTMLElement) target.focus();
  }
  requestIncomingCheck();
}

function networkForm(kind: 'create' | 'join') {
  const switching = snapshot.network !== null;
  const switchHint = switching ? '<p class="switch-notice">Existing notes and files stay on this device. Keep the invitation to return.</p>' : '';
  if (kind === 'create') {
    openModal(`<h2>Create a network</h2><form id="create-network-form"><label for="network-name">Network name</label><input id="network-name" name="name" placeholder="Network name" maxlength="64" required autofocus autocomplete="off"/>${switchHint}<button class="button primary full-width" type="submit">Create network ${icon('arrow')}</button></form>`, 'Create a network');
  } else {
    openModal(`<h2>Join a network</h2><p class="modal-copy">${canScan || desktopCameraAvailable() ? 'Scan a QR code or enter the invitation phrase.' : 'Enter the invitation phrase from another device.'}</p>${canScan || desktopCameraAvailable() ? `<button class="button primary full-width" data-action="scan">${icon('scan')} Scan QR code</button><div class="divider"><span>or enter the phrase</span></div>` : ''}<form id="join-network-form"><label for="network-invite">Invitation phrase</label><textarea id="network-invite" name="invite" class="invite-input" placeholder="Invitation words or Murmur link" required spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>${switchHint}<button class="button secondary full-width" type="submit">Join network ${icon('arrow')}</button></form>`, 'Join a network');
  }
}

async function shareNetwork() {
  if (snapshot.network === null || !await flushSave()) return;
  const network = snapshot.network;
  const qr = await QRCode.toDataURL(network.invite, { width: 640, margin: 3, errorCorrectionLevel: 'M', color: { dark: '#14232eff', light: '#ffffffff' } });
  openModal(`<h2>${esc(network.name)}</h2><p class="modal-copy">Open Murmur on the other device and choose <strong>Join a network</strong>.</p><div class="qr-card"><img class="invite-qr" src="${qr}" alt="QR invitation for ${esc(network.name)}"/><span>Scan to join this network</span></div><section class="phrase-section" aria-label="Invitation phrase"><h3>Invitation phrase</h3><ol class="phrase-grid">${network.phrase.split(/\s+/).map(word => `<li>${esc(word)}</li>`).join('')}</ol></section><button class="button secondary full-width" data-action="copy-invite">${icon('copy')} Copy phrase</button><p class="modal-fine">Anyone with this phrase or QR code can access this network.</p>`, 'Invite a device');
}

async function establishNetwork(next: Snapshot) {
  recoveryPending = true;
  resetImages();
  snapshot = next;
  noteQuery = '';
  noteTagFilter = [];
  fileTagFilter = [];
  section = 'notes';
  selected = null;
  draft = null;
  mobileEditor = false;
  closeModal();
  app.inert = true;
  render();
  try { await recoverDraft(); }
  catch (error) { notify('Could not recover a saved draft: ' + errorText(error)); }
  finally { recoveryPending = false; app.inert = modalRoot.firstElementChild !== null; }
  try { await initializeDiscovery(snapshot); }
  catch (error) { notify(`Notes are ready. Nearby discovery: ${errorText(error)}`); }
}

async function scanWithDesktopCamera() {
  if (!await flushSave()) return;
  const controller = new AbortController();
  desktopScanController = controller;
  scanning = true;
  scanCancelled = false;
  openModal('<h2>Scan an invitation</h2><video id="desktop-camera" aria-label="Camera preview" muted playsinline></video><p id="camera-status" class="modal-copy" role="status">Starting camera…</p><button class="button secondary full-width" data-action="cancel-scan">Cancel scanning</button>', 'Scan an invitation');
  modalRoot.querySelector('.modal')?.classList.add('camera-modal');
  try {
    const video = document.querySelector('#desktop-camera');
    if (!(video instanceof HTMLVideoElement)) throw new Error('The camera preview could not open.');
    const content = await scanDesktopInvitation(video, controller.signal, message => {
      const status = document.querySelector('#camera-status');
      if (status !== null) status.textContent = message;
    });
    if (content !== null && !scanCancelled) {
      desktopScanController = null;
      scanning = false;
      await establishNetwork(await api.joinNetwork(content));
      notify('Network joined.');
    } else networkForm('join');
  } catch (error) {
    networkForm('join');
    if (!scanCancelled) notify(errorText(error));
  } finally {
    controller.abort();
    desktopScanController = null;
    scanning = false;
  }
}

async function scanInvitation() {
  if (!canScan && desktopCameraAvailable()) { await scanWithDesktopCamera(); return; }
  if (!canScan) {
    notify('Camera access is unavailable here. Enter an invitation phrase instead.');
    const field = document.querySelector('#network-invite');
    if (field instanceof HTMLTextAreaElement) field.focus();
    return;
  }
  if (!await flushSave()) return;
  const scanner = await import('@tauri-apps/plugin-barcode-scanner');
  const permission = await scanner.requestPermissions();
  if (permission !== 'granted') {
    notify('Allow camera access in your device settings to scan an invitation. You can also paste one.');
    return;
  }
  closeModal();
  scanning = true;
  scanCancelled = false;
  document.documentElement.classList.add('scanning');
  modalRoot.innerHTML = `<div class="scanner"><header><h2>Scan an invitation</h2><button class="icon-button" data-action="cancel-scan" aria-label="Cancel scanning">${icon('close')}</button></header><div class="scanner-frame" aria-hidden="true"></div><p>Point your camera at a Murmur QR code.</p></div>`;
  try {
    const result: unknown = await scanner.scan({ windowed: true, formats: [scanner.Format.QRCode] });
    const content = text(record(result)['content']);
    if (!scanCancelled) {
      document.documentElement.classList.remove('scanning');
      scanning = false;
      await establishNetwork(await api.joinNetwork(content));
      notify('Network joined.');
    }
  } catch (error) {
    if (!scanCancelled) notify(`Couldn't scan: ${errorText(error)}`);
    networkForm('join');
  } finally {
    document.documentElement.classList.remove('scanning');
    scanning = false;
  }
}

async function handleAction(action: string) {
  switch (action) {
    case 'filter-note-tags': openTagFilter('note'); break;
    case 'filter-file-tags': openTagFilter('file'); break;
    case 'clear-selected-tags':
      if (tagFilterDialog === 'note') { noteTagFilter = []; renderList(); }
      else if (tagFilterDialog === 'file') { fileTagFilter = []; renderFiles(); }
      break;
    case 'edit-note-tags': if (draft !== null) await editTags('note', draft.id); break;
    case 'clear-note-filters':
      noteQuery = ''; noteTagFilter = [];
      { const field = document.querySelector('#note-search'); if (field instanceof HTMLInputElement) field.value = ''; }
      renderList();
      break;
    case 'clear-file-filters': fileTagFilter = []; renderFiles(); break;
    case 'paste-image': {
      const networkId = snapshot.network?.id;
      if (networkId === undefined || fileBusy || section !== 'files') return;
      const file = await readClipboardImage();
      if (snapshot.network?.id !== networkId) throw new Error('The active network changed. Please paste the image again.');
      await importFiles(networkId, [file]);
      break;
    }
    case 'import-shares': requestIncomingCheck(true); break;
    case 'discard-shares':
      openModal('<h2>Discard shared files?</h2><p class="modal-copy">Removes queued copies from Murmur. Original files are unchanged.</p><div class="modal-actions"><button class="button secondary" data-action="close-modal">Keep files</button><button class="button danger" data-action="confirm-discard-shares">Discard files</button></div>', 'Discard shared files');
      break;
    case 'confirm-discard-shares':
      await api.discardShares();
      pendingShares = [];
      shareFailureKey = null;
      closeModal();
      renderPendingShares();
      notify('Shared files discarded.');
      break;
    case 'nav-notes': case 'nav-files': case 'nav-settings':
      if (!await flushSave()) return;
      if (section === 'files' && action !== 'nav-files') resetImages();
      section = action === 'nav-files' && snapshot.network !== null ? 'files' : action === 'nav-settings' ? 'settings' : 'notes';
      mobileEditor = false;
      render();
      break;
    case 'add-files': {
      const picker = document.querySelector('#file-picker');
      if (picker instanceof HTMLInputElement) picker.click();
      break;
    }
    case 'confirm-delete-file':
      if (fileToDelete === null) return;
      {
        const result = await api.deleteFile(fileToDelete.networkId, fileToDelete.id);
        if (snapshot.network?.id !== fileToDelete.networkId) return;
        snapshot = result;
      }
      fileToDelete = null;
      closeModal();
      renderFiles();
      break;
    case 'create-network': if (await flushSave()) networkForm('create'); break;
    case 'join-network': if (await flushSave()) networkForm('join'); break;
    case 'close-modal':
      if (desktopScanController !== null) { scanCancelled = true; desktopScanController.abort(); }
      else closeModal();
      break;
    case 'share': await shareNetwork(); break;
    case 'new-note': {
      if (!await flushSave()) return;
      const previous = new Set(snapshot.notes.map(n => n.id));
      snapshot = await api.createNote();
      const note = snapshot.notes.find(n => !previous.has(n.id));
      if (note !== undefined) await selectNote(note.id);
      const field = document.querySelector('#note-title');
      if (field instanceof HTMLInputElement) field.focus();
      break;
    }
    case 'back':
      if (!await flushSave()) return;
      mobileEditor = false;
      render();
      break;
    case 'delete-note':
      if (draft === null) return;
      openModal(`<div class="modal-symbol">${icon('trash')}</div><h2>Delete this note?</h2><p class="modal-copy">“${esc(noteTitle(draft))}” will also be deleted from the other devices when they connect.</p><div class="modal-actions"><button class="button secondary" data-action="close-modal">Keep note</button><button class="button danger" data-action="confirm-delete">Delete note</button></div>`, 'Delete note');
      break;
    case 'confirm-delete': {
      if (draft === null) return;
      // An explicit deletion supersedes this note's pending draft.
      clearTimeout(saveTimer);
      if (saving !== null) await saving;
      const current = draft;
      const network = snapshot.network;
      // Explicit deletion discards this draft even if its last backup failed.
      await draftWrites.catch(() => undefined);
      snapshot = await api.deleteNote(current.id);
      if (network !== null) await queueDraftWrite(() => api.clearDraft(network.id, current.id));
      draft = null;
      selected = null;
      mobileEditor = false;
      closeModal();
      render();
      break;
    }
    case 'copy-recovered': {
      const current = draft;
      if (current === null) return;
      try {
        await navigator.clipboard.writeText(current.title + '\n\n' + current.body);
        notify('Recovered text copied. You can paste it into a new note.');
      } catch {
        const field = document.querySelector('#note-body');
        if (field instanceof HTMLTextAreaElement) { setNoteMode('write'); field.focus(); field.select(); }
        notify('Select and copy the recovered text below.');
      }
      break;
    }
    case 'network-menu':
      if (!await flushSave() || snapshot.network === null) return;
      openModal(`<h2>${esc(snapshot.network.name)}</h2><p class="modal-copy">Anyone with an invitation can read and edit this network’s notes and files.</p><div class="network-options"><button class="button secondary full-width" data-action="share">${icon('share')} Invite a device</button><button class="button secondary full-width" data-action="create-network">${icon('plus')} Create another network</button><button class="button secondary full-width" data-action="join-network">${icon('scan')} Join another network</button></div><p class="modal-fine">Keep the invitation to return after switching networks.</p>`, 'Manage network');
      break;
    case 'copy-invite':
      if (snapshot.network === null) return;
      try { await navigator.clipboard.writeText(snapshot.network.phrase); notify('Invitation phrase copied.'); }
      catch {
        const existing = modalRoot.querySelector('#copy-fallback');
        if (existing instanceof HTMLTextAreaElement) { existing.select(); break; }
        const area = document.createElement('textarea');
        area.id = 'copy-fallback';
        area.className = 'invite-input';
        area.readOnly = true;
        area.value = snapshot.network.phrase;
        area.setAttribute('aria-label', 'Invitation phrase to copy');
        modalRoot.querySelector('.modal')?.append(area);
        area.select();
        notify('Select and copy the phrase below.');
      }
      break;
    case 'sync':
      if (!await flushSave()) return;
      await initializeDiscovery(snapshot);
      snapshot = await api.sync();
      updateDraftFromSnapshot();
      renderList();
      renderFiles();
      renderStatus();
      notify(native ? 'Looking for your nearby devices.' : 'LAN sync runs in the Android and iOS app.');
      break;
    case 'scan': await scanInvitation(); break;
    case 'cancel-scan': {
      scanCancelled = true;
      if (desktopScanController !== null) { desktopScanController.abort(); return; }
      const scanner = await import('@tauri-apps/plugin-barcode-scanner');
      await scanner.cancel();
      document.documentElement.classList.remove('scanning');
      scanning = false;
      networkForm('join');
      break;
    }
  }
}

document.addEventListener('click', event => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const filterChoice = target.closest('[data-filter-tag]');
  if (filterChoice instanceof HTMLButtonElement) {
    const kind = filterChoice.dataset['filterTag'];
    if ((kind !== 'note' && kind !== 'file') || kind !== tagFilterDialog) return;
    const current = kind === 'note' ? noteTagFilter : fileTagFilter;
    const next = current.includes(filterChoice.value) ? current.filter(tag => tag !== filterChoice.value) : [...current, filterChoice.value];
    if (kind === 'note') { noteTagFilter = next; renderList(); }
    else { fileTagFilter = next; renderFiles(); }
    return;
  }
  const action = target.closest('[data-action]')?.getAttribute('data-action');
  if (action !== null && action !== undefined) {
    // The scanner must remain cancellable while its promise is pending.
    if (action === 'cancel-scan' || action === 'close-modal') void handleAction(action).catch(error => notify(errorText(error)));
    else void perform(() => handleAction(action));
    return;
  }
  const theme = target.closest('button[data-theme]')?.getAttribute('data-theme');
  if (theme !== null && theme !== undefined) {
    void perform(async () => {
      settings = await api.setTheme(parseTheme(theme));
      applyTheme(settings.theme);
      for (const choice of document.querySelectorAll('button[data-theme]')) {
        const active = choice.getAttribute('data-theme') === settings.theme;
        choice.classList.toggle('selected', active);
        choice.setAttribute('aria-pressed', active ? 'true' : 'false');
        choice.querySelector('.icon')?.remove();
        if (active) choice.insertAdjacentHTML('beforeend', icon('check'));
      }
    });
    return;
  }
  const tagFile = target.closest('[data-edit-file-tags]')?.getAttribute('data-edit-file-tags');
  if (tagFile !== undefined && tagFile !== null) { void perform(() => editTags('file', tagFile)); return; }
  const removeTag = target.closest('[data-remove-tag]')?.getAttribute('data-remove-tag');
  if (removeTag !== undefined && removeTag !== null) { void perform(() => changeTag(removeTag, false)); return; }
  const addTag = target.closest('[data-add-tag]')?.getAttribute('data-add-tag');
  if (addTag !== undefined && addTag !== null) { void perform(() => changeTag(addTag, true)); return; }
  const fileOpen = target.closest('[data-open-file]')?.getAttribute('data-open-file');
  if (fileOpen !== undefined && fileOpen !== null) {
    // A dismissed, slow preview must not keep the rest of the app locked.
    if (!actionBusy) void openFile(fileOpen).catch(error => notify(errorText(error)));
    return;
  }
  const fileSave = target.closest('[data-save-file]')?.getAttribute('data-save-file');
  if (fileSave !== undefined && fileSave !== null) { void perform(() => saveFile(fileSave)); return; }
  const fileCopy = target.closest('[data-copy-file]')?.getAttribute('data-copy-file');
  if (fileCopy !== undefined && fileCopy !== null) { void perform(() => copyFileImage(fileCopy)); return; }
  const fileDelete = target.closest('[data-delete-file]')?.getAttribute('data-delete-file');
  if (fileDelete !== undefined && fileDelete !== null) {
    const file = snapshot.files.find(entry => entry.id === fileDelete);
    if (file === undefined) return;
    const networkId = snapshot.network?.id;
    if (networkId === undefined) return;
    fileToDelete = { id: file.id, networkId };
    openModal(`<h2>Delete this file?</h2><p class="modal-copy">“${esc(file.name)}” will be deleted from this network on all devices when they connect. Copies saved outside Murmur stay untouched.</p><div class="modal-actions"><button class="button secondary" data-action="close-modal">Keep file</button><button class="button danger" data-action="confirm-delete-file">Delete file</button></div>`, 'Delete file');
    return;
  }
  const note = target.closest('[data-note]')?.getAttribute('data-note');
  if (note !== null && note !== undefined) void perform(() => selectNote(note));
  if (target.closest('.brand') !== null) {
    event.preventDefault();
    void perform(async () => { if (await flushSave()) { section = 'notes'; mobileEditor = false; render(); } });
  }
  if (target.closest('#save-state') !== null && draft?.dirty === true) void flushSave();
});

document.addEventListener('pointerdown', event => {
  const target = event.target;
  if (tagFilterDialog === null || !(target instanceof Element) || modalRoot.contains(target)) return;
  const triggerId = tagFilterDialog === 'note' ? 'note-tag-filter' : 'file-tag-filter';
  if (target.closest('#' + triggerId) === null) closeModal(false);
});
window.addEventListener('resize', positionTagFilter);
window.visualViewport?.addEventListener('resize', positionTagFilter);
window.visualViewport?.addEventListener('scroll', positionTagFilter);

document.addEventListener('paste', event => {
  const networkId = snapshot.network?.id;
  if (!started || recoveryPending || section !== 'files' || networkId === undefined || actionBusy || fileBusy || modalRoot.firstElementChild !== null) return;
  const target = event.target;
  if (target instanceof Element && target.closest('input, textarea, [contenteditable]') !== null) return;
  const files = [...event.clipboardData?.files ?? []].filter(file => file.type.startsWith('image/'));
  if (files.length === 0) return;
  event.preventDefault();
  void perform(() => importFiles(networkId, files));
});

document.addEventListener('submit', event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.id === 'tag-form') {
    event.preventDefault();
    const field = form.querySelector('#tag-name');
    if (field instanceof HTMLInputElement) void perform(() => changeTag(field.value, true));
    return;
  }
  if (form.id !== 'create-network-form' && form.id !== 'join-network-form') return;
  event.preventDefault();
  const data = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  if (!(button instanceof HTMLButtonElement)) return;
  void perform(async () => {
    if (!await flushSave()) return;
    button.disabled = true;
    try {
      const next = form.id === 'create-network-form'
        ? await api.createNetwork(text(data.get('name')).trim())
        : await api.joinNetwork(text(data.get('invite')).trim());
      await establishNetwork(next);
    } finally { button.disabled = false; }
  });
});

document.addEventListener('change', event => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.id !== 'file-picker' || target.files === null) return;
  const files = Array.from(target.files);
  target.value = '';
  const networkId = snapshot.network?.id;
  if (files.length > 0 && networkId !== undefined) void perform(() => importFiles(networkId, files));
});

document.addEventListener('focusin', event => {
  const target = event.target;
  if (tagFilterDialog !== null && target instanceof Element && !modalRoot.contains(target) && target.id !== 'note-tag-filter' && target.id !== 'file-tag-filter') closeModal(false);
  if (!(target instanceof HTMLElement) || section !== 'notes' || draft === null) return;
  if (target.id !== 'note-title' && target.id !== 'note-body' && target.id !== 'note-markdown-preview') return;
  mobileEditor = true;
  target.closest('.notebook-shell')?.classList.add('editor-open');
  setNoteMode('write');
  if (target.id === 'note-markdown-preview') {
    const body = document.querySelector('#note-body');
    if (body instanceof HTMLTextAreaElement) body.focus({ preventScroll: true });
  }
});

document.addEventListener('focusout', event => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || (target.id !== 'note-title' && target.id !== 'note-body')) return;
  const next = event.relatedTarget;
  if (next instanceof HTMLElement && (next.id === 'note-title' || next.id === 'note-body')) return;
  // Wait for focus to settle so moving between title and body keeps editing.
  setTimeout(() => {
    const focused = document.activeElement;
    if (focused?.id !== 'note-title' && focused?.id !== 'note-body') setNoteMode('preview');
  }, 0);
});

document.addEventListener('input', event => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (target.id === 'tag-name') { renderTagSuggestions(); return; }
  if (target.id === 'note-search') { noteQuery = target.value; renderList(); return; }
  if (draft === null || (target.id !== 'note-title' && target.id !== 'note-body')) return;
  draft[target.id === 'note-title' ? 'title' : 'body'] = target.value;
  draft.version++;
  draft.dirty = true;
  scheduleBackup();
  renderSaveState();
  updateWordCount();
  renderList();
  clearTimeout(saveTimer);
  if (!(event instanceof InputEvent) || !event.isComposing) saveTimer = setTimeout(() => void flushSave(), 220);
});

document.addEventListener('compositionend', () => {
  if (draft?.dirty === true) { clearTimeout(saveTimer); saveTimer = setTimeout(() => void flushSave(), 220); }
});

document.addEventListener('keydown', event => {
  if (tagFilterDialog !== null && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    const choices = [...modalRoot.querySelectorAll('.tag-filter-choice')].filter((element): element is HTMLButtonElement => element instanceof HTMLButtonElement);
    if (choices.length > 0) {
      const index = choices.findIndex(choice => choice === document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : event.key === 'ArrowDown' ? (index + 1) % choices.length : index < 0 ? choices.length - 1 : (index - 1 + choices.length) % choices.length;
      event.preventDefault();
      choices[next]?.focus();
      return;
    }
  }
  if (native && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v' && section === 'files' && modalRoot.firstElementChild === null && !recoveryPending) {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('input, textarea, [contenteditable]') === null) {
      event.preventDefault();
      void perform(() => handleAction('paste-image'));
      return;
    }
  }
  if (event.key === 'Escape') {
    if (scanning) void handleAction('cancel-scan').catch(error => notify(errorText(error)));
    else closeModal();
  }
  if (event.key === 'Tab' && tagFilterDialog === null && modalRoot.firstElementChild !== null) {
    const focusable = [...modalRoot.querySelectorAll('button, input, textarea, [tabindex="0"]')].filter((node): node is HTMLElement => node instanceof HTMLElement && !node.hasAttribute('disabled'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); void flushSave(); }
});

async function refresh() {
  if (!started || document.hidden || actionBusy || saving !== null || scanning) return;
  const epoch = mutation;
  try {
    const next = await api.snapshot();
    if (epoch !== mutation) return;
    snapshot = next;
    updateDraftFromSnapshot();
    renderList();
    renderFiles();
    renderStatus();
  } catch (error) { renderSaveState(`Connection to app interrupted: ${errorText(error)}`, true); }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { scheduleBackup(); void flushSave(); }
  else if (started) {
    void initializeDiscovery(snapshot).catch(error => notify(`Nearby discovery: ${errorText(error)}`));
    void refresh();
    requestIncomingCheck(true);
  }
});
window.addEventListener('focus', () => requestIncomingCheck(true));
window.addEventListener('pagehide', () => { if (activeFilePreview !== null) closeModal(); scheduleBackup(); void flushSave(); });
window.addEventListener('murmur:discovery-error', event => {
  renderStatus();
  if (event instanceof CustomEvent) {
    const detail: unknown = event.detail;
    if (typeof detail === 'string') notify(detail);
  }
});
window.addEventListener('beforeunload', event => {
  if (draft?.dirty === true) { scheduleBackup(); event.preventDefault(); }
});

async function start() {
  recoveryPending = true;
  app.inert = true;
  try {
    snapshot = await api.bootstrap();
    try { canScan = await api.canScan(); }
    catch (error) { notify('Could not check camera availability. You can paste invitations. ' + errorText(error)); }
    try { settings = await api.getSettings(); applyTheme(settings.theme); }
    catch (error) { notify('Could not load your appearance preference: ' + errorText(error)); }
    render();
    try { await recoverDraft(); }
    catch (error) { notify('Could not recover a saved draft: ' + errorText(error)); }
    started = true;
    recoveryPending = false;
    app.inert = modalRoot.firstElementChild !== null;
    await initializeDiscovery(snapshot).catch(error => notify(`Your notes are ready. Nearby discovery: ${errorText(error)}`));
    if (native && !shareListenerReady) {
      try { await api.listenForShares(() => requestIncomingCheck(true)); shareListenerReady = true; }
      catch (error) { notify('Shared files will be checked when the app refreshes. ' + errorText(error)); }
    }
    requestIncomingCheck();
    setInterval(() => { void refresh(); void checkIncomingShares(); }, 3000);
  } catch (error) {
    recoveryPending = false;
    app.inert = modalRoot.firstElementChild !== null;
    app.innerHTML = `<main class="startup-error">${brand()}<h1>Couldn't open your notebook.</h1><p>${esc(errorText(error))}</p><button class="button primary" id="retry-start">Try again</button></main>`;
    document.querySelector('#retry-start')?.addEventListener('click', () => void start());
  }
}

void start();
