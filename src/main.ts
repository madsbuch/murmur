import QRCode from 'qrcode';
import { api, native } from './bridge';
import { mapCaret, rebaseDraft } from './rebase';
import type { DraftBackup, Note, Snapshot } from './types';
import { errorText, parseDraft, record, text } from './validation';
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
  document.documentElement.style.setProperty('--app-height', (window.visualViewport?.height ?? window.innerHeight).toString() + 'px');
}
fitViewport();
window.visualViewport?.addEventListener('resize', fitViewport);
window.addEventListener('resize', fitViewport);
let snapshot: Snapshot = { network: null, notes: [], heads: [], status: { peers: 0, lastSync: null, error: null }, deviceId: '', listenerPort: 0 };
let started = false;
let draftWrites: Promise<void> = Promise.resolve();
let selected: string | null = null;
let mobileEditor = false;
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
const notePreview = (body: string) => body.trim().length === 0 ? 'A blank page, ready for you.' : body.trim().replace(/\s+/g, ' ').slice(0, 115);
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
  return native ? '' : '<div class="preview-banner">Browser preview <span>·</span> Temporary demo; reload clears these notes. The mobile app saves locally and supports nearby sync and scanning.</div>';
}

function render() {
  if (snapshot.network === null) {
    app.innerHTML = `${previewBanner()}<div class="welcome-shell"><header class="topbar">${brand()}<span class="eyebrow welcome-topline">A nearby kind of notebook</span></header><main class="welcome"><div class="welcome-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="orbit orbit-three"></div><div class="art-note art-note-one"><i></i><i></i><i></i></div><div class="art-note art-note-two"><i></i><i></i><i></i></div><span class="art-dot"></span></div><p class="eyebrow">Small circles. Shared thoughts.</p><h1>Notes,<br/><em>kept close.</em></h1><p class="welcome-copy">A quiet place for your notes, shared directly with the people and devices nearby.</p><div class="welcome-actions"><button class="button primary" data-action="create-network">Create a network ${icon('plus')}</button><button class="button secondary" data-action="join-network">Join a network ${icon('scan')}</button></div><div class="welcome-foot">${icon('lock')} On your devices. Available offline. Always yours.</div></main><footer class="welcome-footer"><span>No accounts. No cloud.</span><span>Just a little connection.</span></footer></div>`;
    return;
  }
  app.innerHTML = `${previewBanner()}<div class="notebook-shell ${mobileEditor ? 'editor-open' : ''}"><header class="topbar">${brand()}<button class="network-pill" data-action="share"><span class="status-dot"></span><span>${esc(snapshot.network.name)}</span>${icon('arrow')}</button></header><main class="workspace"><aside class="sidebar"><div class="sidebar-heading"><div><p class="eyebrow">Your shared notebook</p><h1>Notes <span id="note-count">${snapshot.notes.length.toString()}</span></h1></div><button class="icon-button new-note-small" data-action="new-note" aria-label="New note">${icon('plus')}</button></div><button class="button primary new-note" data-action="new-note">${icon('plus')} New note</button><div id="note-list" class="note-list"></div><div class="sidebar-bottom"><div id="sync-status"></div><button class="text-button network-manage" data-action="network-menu">Manage network ${icon('arrow')}</button></div></aside><section class="editor-panel" aria-label="Note editor"><div id="editor"></div></section></main><footer class="notebook-footer"><span>${icon('lock')} Saved here. Shared nearby.</span><button class="text-button" data-action="share">${icon('share')} Invite a device</button></footer></div>`;
  renderList();
  renderEditor();
  renderStatus();
}

function renderList() {
  const list = document.querySelector('#note-list');
  if (list === null) return;
  const count = document.querySelector('#note-count');
  if (count !== null) count.textContent = snapshot.notes.length.toString();
  const notes = [...snapshot.notes].sort((a, b) => b.updatedAt - a.updatedAt);
  list.innerHTML = notes.length > 0 ? notes.map(note => {
    const value = draft?.id === note.id ? draft : note;
    return `<button class="note-card ${selected === note.id ? 'active' : ''}" data-note="${esc(note.id)}" ${selected === note.id ? 'aria-current="true"' : ''}><span class="note-card-title">${esc(noteTitle(value))}</span><span class="note-card-preview">${esc(notePreview(value.body))}</span><span class="note-card-date">${displayDate(note.updatedAt)}<span class="note-card-arrow">${icon('arrow')}</span></span></button>`;
  }).join('') : '<div class="list-empty">Your first thought<br/>belongs here.</div>';
}

function renderEditor() {
  const editor = document.querySelector('#editor');
  if (editor === null) return;
  if (draft === null) {
    editor.innerHTML = `<div class="editor-empty"><div class="empty-mark">${icon('note')}</div><p class="eyebrow">Room for a thought</p><h2>Start with a blank page.</h2><p>A list, a little idea, something to remember.<br/>Your notes will find their way to your network.</p><button class="button secondary" data-action="new-note">${icon('plus')} Write your first note</button></div>`;
    return;
  }
  editor.innerHTML = `<div class="editor-toolbar"><button class="text-button back-notes" data-action="back">${icon('back')} Notes</button><span class="editor-label">${icon('note')} Note</span><div class="editor-tools">${snapshot.notes.some(note => note.id === draft?.id) ? '' : '<button class="text-button" data-action="copy-recovered">Copy recovered text</button>'}<span id="save-state" class="save-state" aria-live="polite"></span><button class="icon-button delete-note" data-action="delete-note" aria-label="Delete this note">${icon('trash')}</button></div></div><div class="writing-area"><input id="note-title" class="note-title" aria-label="Note title" placeholder="Untitled note" maxlength="256" autocomplete="off" value="${esc(draft.title)}"/><textarea id="note-body" class="note-body" aria-label="Note text" placeholder="Let a thought land here…" spellcheck="true">${esc(draft.body)}</textarea></div><div class="editor-bottom"><span id="word-count"></span><span>Yours, even offline</span></div>`;
  renderSaveState();
  updateWordCount();
}

function renderStatus() {
  const status = document.querySelector('#sync-status');
  if (status === null) return;
  const connected = snapshot.status.peers > 0;
  const error = snapshot.status.error ?? getDiscoveryError();
  status.innerHTML = `<div class="connection-line"><span class="status-dot ${connected ? '' : 'idle'}"></span><strong>${connected ? `${snapshot.status.peers.toString()} nearby ${snapshot.status.peers === 1 ? 'device' : 'devices'}` : 'Ready for nearby devices'}</strong><button class="icon-button sync-button" data-action="sync" aria-label="Retry synchronization">${icon('sync')}</button></div><p class="connection-copy">${error.length > 0 ? esc(error) : connected ? 'Your notes sync automatically.' : 'Open Murmur on the same Wi-Fi to sync.'}</p>`;
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
  finally { actionBusy = false; mutation++; }
}

function openModal(content: string, label: string) {
  if (modalRoot.firstElementChild === null) modalPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(label)}"><button class="icon-button modal-close" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button>${content}</section></div>`;
  app.inert = true;
  setTimeout(() => {
    const field = modalRoot.querySelector('[autofocus], input, textarea, button:not(.modal-close)');
    if (field instanceof HTMLElement) field.focus();
  }, 30);
}

function closeModal() {
  modalRoot.innerHTML = '';
  app.inert = false;
  modalPreviousFocus?.focus();
}

function networkForm(kind: 'create' | 'join') {
  const switching = snapshot.network !== null;
  const switchHint = switching ? '<p class="switch-notice">This switches your active network. Existing notes stay on this device; keep its invitation to return.</p>' : '';
  if (kind === 'create') {
    openModal(`<div class="modal-symbol">${icon('plus')}</div><p class="eyebrow">Start a small circle</p><h2>Create a network</h2><p class="modal-copy">Give your shared notebook a name. Then invite another device with a QR code.</p><form id="create-network-form"><label for="network-name">Network name</label><input id="network-name" name="name" placeholder="Our little corner" maxlength="64" required autofocus autocomplete="off"/>${switchHint}<button class="button primary full-width" type="submit">Create network ${icon('arrow')}</button></form><p class="modal-fine">No sign-up. Your device makes the connection.</p>`, 'Create a network');
  } else {
    openModal(`<div class="modal-symbol">${icon('scan')}</div><p class="eyebrow">A place to belong</p><h2>Join a network</h2><p class="modal-copy">Scan the invitation on another device. You'll share notes whenever you're on the same Wi-Fi.</p><button class="button primary full-width" data-action="scan">${icon('scan')} Scan QR code</button><div class="divider"><span>or paste an invitation</span></div><form id="join-network-form"><label class="sr-only" for="network-invite">Network invitation</label><textarea id="network-invite" name="invite" class="invite-input" placeholder="murmur://join#…" required spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>${switchHint}<button class="button secondary full-width" type="submit">Join network ${icon('arrow')}</button></form>`, 'Join a network');
  }
}

async function shareNetwork() {
  if (snapshot.network === null || !await flushSave()) return;
  const network = snapshot.network;
  const qr = await QRCode.toDataURL(network.invite, { width: 640, margin: 3, errorCorrectionLevel: 'M', color: { dark: '#213d2eff', light: '#ffffffff' } });
  openModal(`<p class="eyebrow">Bring another device closer</p><h2>${esc(network.name)}</h2><p class="modal-copy">Open Murmur on the other device and choose <strong>Join a network</strong>.</p><div class="qr-card"><img class="invite-qr" src="${qr}" alt="QR invitation for ${esc(network.name)}"/><span>Scan to join this network</span></div><div class="network-id"><span>NETWORK ID</span><code>${esc(network.id)}</code></div><button class="button secondary full-width" data-action="copy-invite">${icon('copy')} Copy invitation</button><p class="modal-fine">This code contains your shared secret. Anyone with it can read and edit this network's notes.</p>`, 'Invite a device');
}

async function establishNetwork(next: Snapshot) {
  snapshot = next;
  selected = null;
  draft = null;
  mobileEditor = false;
  closeModal();
  app.inert = true;
  render();
  try { await recoverDraft(); }
  catch (error) { notify('Could not recover a saved draft: ' + errorText(error)); }
  finally { app.inert = false; }
  try { await initializeDiscovery(snapshot); }
  catch (error) { notify(`Notes are ready. Nearby discovery: ${errorText(error)}`); }
}

async function scanInvitation() {
  if (!native) {
    notify('QR scanning is available in the Android and iOS app. You can paste an invitation in this browser preview.');
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
      notify('You’re in. Your notes will arrive when another device is nearby.');
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
    case 'create-network': if (await flushSave()) networkForm('create'); break;
    case 'join-network': if (await flushSave()) networkForm('join'); break;
    case 'close-modal': closeModal(); break;
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
        if (field instanceof HTMLTextAreaElement) { field.focus(); field.select(); }
        notify('Select and copy the recovered text below.');
      }
      break;
    }
    case 'network-menu':
      if (!await flushSave() || snapshot.network === null) return;
      openModal(`<p class="eyebrow">Your network</p><h2>${esc(snapshot.network.name)}</h2><p class="modal-copy">Everyone in this network can read and edit its notes. Devices find each other on the same Wi-Fi.</p><div class="network-options"><button class="button secondary full-width" data-action="share">${icon('share')} Invite a device</button><button class="button secondary full-width" data-action="create-network">${icon('plus')} Create another network</button><button class="button secondary full-width" data-action="join-network">${icon('scan')} Join another network</button></div><p class="modal-fine">Switching keeps your existing notes on this device. Save the invitation to come back.</p>`, 'Manage network');
      break;
    case 'copy-invite':
      if (snapshot.network === null) return;
      try { await navigator.clipboard.writeText(snapshot.network.invite); notify('Invitation copied. Share it with someone you trust.'); }
      catch {
        const existing = modalRoot.querySelector('#copy-fallback');
        if (existing instanceof HTMLTextAreaElement) { existing.select(); break; }
        const area = document.createElement('textarea');
        area.id = 'copy-fallback';
        area.className = 'invite-input';
        area.readOnly = true;
        area.value = snapshot.network.invite;
        area.setAttribute('aria-label', 'Invitation to copy');
        modalRoot.querySelector('.modal')?.append(area);
        area.select();
        notify('Select and copy the invitation below.');
      }
      break;
    case 'sync':
      if (!await flushSave()) return;
      await initializeDiscovery(snapshot);
      snapshot = await api.sync();
      updateDraftFromSnapshot();
      renderList();
      renderStatus();
      notify(native ? 'Looking for your nearby devices.' : 'LAN sync runs in the Android and iOS app.');
      break;
    case 'scan': await scanInvitation(); break;
    case 'cancel-scan': {
      scanCancelled = true;
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
  const action = target.closest('[data-action]')?.getAttribute('data-action');
  if (action !== null && action !== undefined) {
    // The scanner must remain cancellable while its promise is pending.
    if (action === 'cancel-scan' || action === 'close-modal') void handleAction(action).catch(error => notify(errorText(error)));
    else void perform(() => handleAction(action));
    return;
  }
  const note = target.closest('[data-note]')?.getAttribute('data-note');
  if (note !== null && note !== undefined) void perform(() => selectNote(note));
  if (target.closest('.brand') !== null) {
    event.preventDefault();
    void perform(async () => { if (await flushSave()) { mobileEditor = false; render(); } });
  }
  if (target.closest('#save-state') !== null && draft?.dirty === true) void flushSave();
});

document.addEventListener('submit', event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
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

document.addEventListener('input', event => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
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
  if (event.key === 'Escape') {
    if (scanning) void handleAction('cancel-scan').catch(error => notify(errorText(error)));
    else closeModal();
  }
  if (event.key === 'Tab' && modalRoot.firstElementChild !== null) {
    const focusable = [...modalRoot.querySelectorAll('button, input, textarea, [tabindex="0"]')].filter((node): node is HTMLElement => node instanceof HTMLElement && !node.hasAttribute('disabled'));
    const first = focusable[0];
    const last = focusable.at(-1);
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
    renderStatus();
  } catch (error) { renderSaveState(`Connection to app interrupted: ${errorText(error)}`, true); }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { scheduleBackup(); void flushSave(); }
  else if (started) {
    void initializeDiscovery(snapshot).catch(error => notify(`Nearby discovery: ${errorText(error)}`));
    void refresh();
  }
});
window.addEventListener('pagehide', () => { scheduleBackup(); void flushSave(); });
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
  app.inert = true;
  try {
    snapshot = await api.bootstrap();
    render();
    try { await recoverDraft(); }
    catch (error) { notify('Could not recover a saved draft: ' + errorText(error)); }
    started = true;
    app.inert = false;
    await initializeDiscovery(snapshot).catch(error => notify(`Your notes are ready. Nearby discovery: ${errorText(error)}`));
    setInterval(() => void refresh(), 3000);
  } catch (error) {
    app.inert = false;
    app.innerHTML = `<main class="startup-error">${brand()}<h1>Couldn't open your notebook.</h1><p>${esc(errorText(error))}</p><button class="button primary" id="retry-start">Try again</button></main>`;
    document.querySelector('#retry-start')?.addEventListener('click', () => void start());
  }
}

void start();
