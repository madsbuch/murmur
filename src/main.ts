import QRCode from 'qrcode';
import { api, native } from './bridge';
import { mapCaret, rebaseDraft } from './rebase';
import type { Note, Snapshot } from './types';
import { getDiscoveryError, initializeDiscovery } from '../native';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
const modalRoot = document.querySelector<HTMLDivElement>('#modal-root')!;
const toast = document.querySelector<HTMLDivElement>('#toast')!;
// Webview keyboards resize the visual viewport on iOS as well as Android.
function fitViewport() {
  document.documentElement.style.setProperty('--app-height', `${window.visualViewport?.height ?? window.innerHeight}px`);
}
fitViewport();
window.visualViewport?.addEventListener('resize', fitViewport);
window.addEventListener('resize', fitViewport);
let snapshot: Snapshot;
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
const icon = (name: string, className = '') => `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.note}</svg>`;
const esc = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const noteTitle = (note: Pick<Note, 'title'>) => note.title.trim() || 'Untitled note';
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
  return native ? '' : '<div class="preview-banner">Browser preview <span>·</span> Notes stay in this browser. LAN sync and scanning run in the mobile app.</div>';
}

function render() {
  if (!snapshot.network) {
    app.innerHTML = `${previewBanner()}<div class="welcome-shell"><header class="topbar">${brand()}<span class="eyebrow welcome-topline">A nearby kind of notebook</span></header><main class="welcome"><div class="welcome-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="orbit orbit-three"></div><div class="art-note art-note-one"><i></i><i></i><i></i></div><div class="art-note art-note-two"><i></i><i></i><i></i></div><span class="art-dot"></span></div><p class="eyebrow">Small circles. Shared thoughts.</p><h1>Notes,<br/><em>kept close.</em></h1><p class="welcome-copy">A quiet place for your notes, shared directly with the people and devices nearby.</p><div class="welcome-actions"><button class="button primary" data-action="create-network">Create a network ${icon('plus')}</button><button class="button secondary" data-action="join-network">Join a network ${icon('scan')}</button></div><div class="welcome-foot">${icon('lock')} On your devices. Available offline. Always yours.</div></main><footer class="welcome-footer"><span>No accounts. No cloud.</span><span>Just a little connection.</span></footer></div>`;
    return;
  }
  app.innerHTML = `${previewBanner()}<div class="notebook-shell ${mobileEditor ? 'editor-open' : ''}"><header class="topbar">${brand()}<button class="network-pill" data-action="share"><span class="status-dot"></span><span>${esc(snapshot.network.name)}</span>${icon('arrow')}</button></header><main class="workspace"><aside class="sidebar"><div class="sidebar-heading"><div><p class="eyebrow">Your shared notebook</p><h1>Notes <span id="note-count">${snapshot.notes.length}</span></h1></div><button class="icon-button new-note-small" data-action="new-note" aria-label="New note">${icon('plus')}</button></div><button class="button primary new-note" data-action="new-note">${icon('plus')} New note</button><div id="note-list" class="note-list"></div><div class="sidebar-bottom"><div id="sync-status"></div><button class="text-button network-manage" data-action="network-menu">Manage network ${icon('arrow')}</button></div></aside><section class="editor-panel" aria-label="Note editor"><div id="editor"></div></section></main><footer class="notebook-footer"><span>${icon('lock')} Saved here. Shared nearby.</span><button class="text-button" data-action="share">${icon('share')} Invite a device</button></footer></div>`;
  renderList();
  renderEditor();
  renderStatus();
}

function renderList() {
  const list = document.querySelector('#note-list');
  if (!list) return;
  const count = document.querySelector('#note-count');
  if (count) count.textContent = String(snapshot.notes.length);
  const notes = [...snapshot.notes].sort((a, b) => b.updatedAt - a.updatedAt);
  list.innerHTML = notes.length ? notes.map(note => {
    const value = draft?.id === note.id ? draft : note;
    return `<button class="note-card ${selected === note.id ? 'active' : ''}" data-note="${esc(note.id)}" ${selected === note.id ? 'aria-current="true"' : ''}><span class="note-card-title">${esc(noteTitle(value))}</span><span class="note-card-preview">${esc(value.body.trim().replace(/\s+/g, ' ').slice(0, 115) || 'A blank page, ready for you.')}</span><span class="note-card-date">${displayDate(note.updatedAt)}<span class="note-card-arrow">${icon('arrow')}</span></span></button>`;
  }).join('') : '<div class="list-empty">Your first thought<br/>belongs here.</div>';
}

function renderEditor() {
  const editor = document.querySelector('#editor');
  if (!editor) return;
  if (!draft) {
    editor.innerHTML = `<div class="editor-empty"><div class="empty-mark">${icon('note')}</div><p class="eyebrow">Room for a thought</p><h2>Start with a blank page.</h2><p>A list, a little idea, something to remember.<br/>Your notes will find their way to your network.</p><button class="button secondary" data-action="new-note">${icon('plus')} Write your first note</button></div>`;
    return;
  }
  editor.innerHTML = `<div class="editor-toolbar"><button class="text-button back-notes" data-action="back">${icon('back')} Notes</button><span class="editor-label">${icon('note')} Note</span><div class="editor-tools"><span id="save-state" class="save-state" aria-live="polite"></span><button class="icon-button delete-note" data-action="delete-note" aria-label="Delete this note">${icon('trash')}</button></div></div><div class="writing-area"><input id="note-title" class="note-title" aria-label="Note title" placeholder="Untitled note" maxlength="256" autocomplete="off" value="${esc(draft.title)}"/><textarea id="note-body" class="note-body" aria-label="Note text" placeholder="Let a thought land here…" spellcheck="true">${esc(draft.body)}</textarea></div><div class="editor-bottom"><span id="word-count"></span><span>Yours, even offline</span></div>`;
  renderSaveState();
  updateWordCount();
}

function renderStatus() {
  const status = document.querySelector('#sync-status');
  if (!status) return;
  const connected = snapshot.status.peers > 0;
  const error = snapshot.status.error || getDiscoveryError();
  status.innerHTML = `<div class="connection-line"><span class="status-dot ${connected ? '' : 'idle'}"></span><strong>${connected ? `${snapshot.status.peers} nearby ${snapshot.status.peers === 1 ? 'device' : 'devices'}` : 'Ready for nearby devices'}</strong><button class="icon-button sync-button" data-action="sync" aria-label="Retry synchronization">${icon('sync')}</button></div><p class="connection-copy">${error ? esc(error) : connected ? 'Your notes sync automatically.' : 'Open Murmur on the same Wi-Fi to sync.'}</p>`;
}

function renderSaveState(message?: string, failed = false) {
  const label = document.querySelector('#save-state');
  if (!label) return;
  label.className = `save-state ${failed ? 'save-failed' : ''}`;
  label.innerHTML = message ? esc(message) : draft?.dirty ? 'Saving…' : `${icon('check')} Saved on device`;
}

function updateWordCount() {
  const words = draft?.body.trim().split(/\s+/).filter(Boolean).length ?? 0;
  const label = document.querySelector('#word-count');
  if (label) label.textContent = `${words} ${words === 1 ? 'word' : 'words'}`;
}

function backupDraft() {
  try {
    if (draft?.dirty) localStorage.setItem('murmur-unsaved-draft', JSON.stringify({ ...draft, networkId: snapshot.network?.id }));
    else localStorage.removeItem('murmur-unsaved-draft');
  } catch { /* Native disk persistence remains authoritative if the webview storage is full. */ }
}

function setFieldValue(id: string, value: string) {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(id);
  if (!field || field.value === value) return;
  const before = field.value;
  const start = field.selectionStart ?? 0;
  const end = field.selectionEnd ?? start;
  field.value = value;
  if (document.activeElement === field) field.setSelectionRange(mapCaret(before, value, start), mapCaret(before, value, end));
}

function updateDraftFromSnapshot() {
  if (!draft || draft.dirty || saving) return;
  const note = snapshot.notes.find(n => n.id === draft!.id);
  if (!note) {
    draft = null;
    selected = null;
    mobileEditor = false;
    render();
    notify('This note was deleted by another device.');
    return;
  }
  draft.title = note.title;
  draft.body = note.body;
  draft.baseHeads = snapshot.heads;
  setFieldValue('#note-title', note.title);
  setFieldValue('#note-body', note.body);
  updateWordCount();
}

async function flushSave(): Promise<boolean> {
  clearTimeout(saveTimer);
  if (saving) {
    const ok = await saving;
    return ok && draft?.dirty ? flushSave() : ok;
  }
  if (!draft?.dirty) return true;
  const sent = { ...draft, baseHeads: [...draft.baseHeads] };
  mutation++;
  const operation = (async () => {
    try {
      const result = await api.updateNote(sent.id, sent.title, sent.body, sent.baseHeads);
      snapshot = result;
      const note = result.notes.find(n => n.id === sent.id);
      if (!note) throw new Error('This note was deleted on another device. Your draft is still here to copy.');
      if (draft?.id === sent.id) {
        const hasMoreInput = draft.version !== sent.version;
        draft.title = hasMoreInput ? rebaseDraft(sent.title, draft.title, note.title) : note.title;
        draft.body = hasMoreInput ? rebaseDraft(sent.body, draft.body, note.body) : note.body;
        draft.baseHeads = result.heads;
        draft.dirty = draft.title !== note.title || draft.body !== note.body;
        setFieldValue('#note-title', draft.title);
        setFieldValue('#note-body', draft.body);
        backupDraft();
      }
      renderList();
      renderSaveState();
      renderStatus();
      updateWordCount();
      return true;
    } catch (error) {
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
  if (ok && draft?.dirty) return flushSave();
  return ok;
}

async function selectNote(id: string) {
  if (!await flushSave()) return;
  const note = snapshot.notes.find(n => n.id === id);
  if (!note) return;
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
  if (!modalRoot.firstElementChild) modalPreviousFocus = document.activeElement as HTMLElement;
  modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(label)}"><button class="icon-button modal-close" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button>${content}</section></div>`;
  app.inert = true;
  setTimeout(() => modalRoot.querySelector<HTMLElement>('[autofocus], input, textarea, button:not(.modal-close)')?.focus(), 30);
}

function closeModal() {
  modalRoot.innerHTML = '';
  app.inert = false;
  modalPreviousFocus?.focus();
}

function networkForm(kind: 'create' | 'join') {
  const switching = !!snapshot.network;
  const switchHint = switching ? '<p class="switch-notice">This switches your active network. Existing notes stay on this device; keep its invitation to return.</p>' : '';
  if (kind === 'create') {
    openModal(`<div class="modal-symbol">${icon('plus')}</div><p class="eyebrow">Start a small circle</p><h2>Create a network</h2><p class="modal-copy">Give your shared notebook a name. Then invite another device with a QR code.</p><form id="create-network-form"><label for="network-name">Network name</label><input id="network-name" name="name" placeholder="Our little corner" maxlength="64" required autofocus autocomplete="off"/>${switchHint}<button class="button primary full-width" type="submit">Create network ${icon('arrow')}</button></form><p class="modal-fine">No sign-up. Your device makes the connection.</p>`, 'Create a network');
  } else {
    openModal(`<div class="modal-symbol">${icon('scan')}</div><p class="eyebrow">A place to belong</p><h2>Join a network</h2><p class="modal-copy">Scan the invitation on another device. You'll share notes whenever you're on the same Wi-Fi.</p><button class="button primary full-width" data-action="scan">${icon('scan')} Scan QR code</button><div class="divider"><span>or paste an invitation</span></div><form id="join-network-form"><label class="sr-only" for="network-invite">Network invitation</label><textarea id="network-invite" name="invite" class="invite-input" placeholder="murmur://join#…" required spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>${switchHint}<button class="button secondary full-width" type="submit">Join network ${icon('arrow')}</button></form>`, 'Join a network');
  }
}

async function shareNetwork() {
  if (!snapshot.network || !await flushSave()) return;
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
  render();
  try { await initializeDiscovery(snapshot); }
  catch (error) { notify(`Notes are ready. Nearby discovery: ${errorText(error)}`); }
}

async function scanInvitation() {
  if (!native) {
    notify('QR scanning is available in the Android and iOS app. You can paste an invitation in this browser preview.');
    document.querySelector<HTMLTextAreaElement>('#network-invite')?.focus();
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
    const result = await scanner.scan({ windowed: true, formats: [scanner.Format.QRCode] });
    if (!scanCancelled) {
      document.documentElement.classList.remove('scanning');
      scanning = false;
      await establishNetwork(await api.joinNetwork(result.content));
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
      if (note) await selectNote(note.id);
      document.querySelector<HTMLInputElement>('#note-title')?.focus();
      break;
    }
    case 'back':
      if (!await flushSave()) return;
      mobileEditor = false;
      render();
      break;
    case 'delete-note':
      if (!draft) return;
      openModal(`<div class="modal-symbol">${icon('trash')}</div><h2>Delete this note?</h2><p class="modal-copy">“${esc(noteTitle(draft))}” will also be deleted from the other devices when they connect.</p><div class="modal-actions"><button class="button secondary" data-action="close-modal">Keep note</button><button class="button danger" data-action="confirm-delete">Delete note</button></div>`, 'Delete note');
      break;
    case 'confirm-delete': {
      if (!draft) return;
      // An explicit deletion supersedes this note's pending draft.
      clearTimeout(saveTimer);
      if (saving) await saving;
      snapshot = await api.deleteNote(draft.id);
      draft = null;
      selected = null;
      backupDraft();
      mobileEditor = false;
      closeModal();
      render();
      break;
    }
    case 'network-menu':
      if (!await flushSave()) return;
      openModal(`<p class="eyebrow">Your network</p><h2>${esc(snapshot.network!.name)}</h2><p class="modal-copy">Everyone in this network can read and edit its notes. Devices find each other on the same Wi-Fi.</p><div class="network-options"><button class="button secondary full-width" data-action="share">${icon('share')} Invite a device</button><button class="button secondary full-width" data-action="create-network">${icon('plus')} Create another network</button><button class="button secondary full-width" data-action="join-network">${icon('scan')} Join another network</button></div><p class="modal-fine">Switching keeps your existing notes on this device. Save the invitation to come back.</p>`, 'Manage network');
      break;
    case 'copy-invite':
      try { await navigator.clipboard.writeText(snapshot.network!.invite); notify('Invitation copied. Share it with someone you trust.'); }
      catch {
        const existing = modalRoot.querySelector<HTMLTextAreaElement>('#copy-fallback');
        if (existing) { existing.select(); break; }
        const area = document.createElement('textarea');
        area.id = 'copy-fallback';
        area.className = 'invite-input';
        area.readOnly = true;
        area.value = snapshot.network!.invite;
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
  const target = event.target as HTMLElement;
  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
  if (action) {
    // The scanner must remain cancellable while its promise is pending.
    if (action === 'cancel-scan' || action === 'close-modal') void handleAction(action).catch(error => notify(errorText(error)));
    else void perform(() => handleAction(action));
    return;
  }
  const note = target.closest<HTMLElement>('[data-note]')?.dataset.note;
  if (note) void perform(() => selectNote(note));
  if (target.closest('.brand')) {
    event.preventDefault();
    void perform(async () => { if (await flushSave()) { mobileEditor = false; render(); } });
  }
  if (target.closest('#save-state') && draft?.dirty) void flushSave();
});

document.addEventListener('submit', event => {
  const form = event.target as HTMLFormElement;
  if (form.id !== 'create-network-form' && form.id !== 'join-network-form') return;
  event.preventDefault();
  const data = new FormData(form);
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  void perform(async () => {
    if (!await flushSave()) return;
    button.disabled = true;
    try {
      const next = form.id === 'create-network-form'
        ? await api.createNetwork(String(data.get('name')).trim())
        : await api.joinNetwork(String(data.get('invite')).trim());
      await establishNetwork(next);
    } finally { button.disabled = false; }
  });
});

document.addEventListener('input', event => {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement;
  if (!draft || (target.id !== 'note-title' && target.id !== 'note-body')) return;
  draft[target.id === 'note-title' ? 'title' : 'body'] = target.value;
  draft.version++;
  draft.dirty = true;
  backupDraft();
  renderSaveState();
  updateWordCount();
  renderList();
  clearTimeout(saveTimer);
  if (!(event as InputEvent).isComposing) saveTimer = setTimeout(() => void flushSave(), 220);
});

document.addEventListener('compositionend', () => {
  if (draft?.dirty) { clearTimeout(saveTimer); saveTimer = setTimeout(() => void flushSave(), 220); }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (scanning) void handleAction('cancel-scan').catch(error => notify(errorText(error)));
    else closeModal();
  }
  if (event.key === 'Tab' && modalRoot.firstElementChild) {
    const focusable = [...modalRoot.querySelectorAll<HTMLElement>('button, input, textarea, [tabindex="0"]')].filter(node => !node.hasAttribute('disabled'));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); void flushSave(); }
});

async function refresh() {
  if (!snapshot || document.hidden || actionBusy || saving || scanning) return;
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
  if (document.hidden) { backupDraft(); void flushSave(); }
  else if (snapshot) {
    void initializeDiscovery(snapshot).catch(error => notify(`Nearby discovery: ${errorText(error)}`));
    void refresh();
  }
});
window.addEventListener('pagehide', () => { backupDraft(); void flushSave(); });
window.addEventListener('murmur:discovery-error', event => {
  renderStatus();
  notify((event as CustomEvent<string>).detail);
});
window.addEventListener('beforeunload', event => {
  if (draft?.dirty) { backupDraft(); event.preventDefault(); }
});

async function start() {
  try {
    snapshot = await api.bootstrap();
    render();
    try {
      const stored = localStorage.getItem('murmur-unsaved-draft');
      if (stored) {
        const recovered = JSON.parse(stored);
        if (recovered.networkId === snapshot.network?.id && snapshot.notes.some(n => n.id === recovered.id) && typeof recovered.title === 'string' && typeof recovered.body === 'string' && Array.isArray(recovered.baseHeads)) {
          draft = { id: recovered.id, title: recovered.title, body: recovered.body, baseHeads: recovered.baseHeads, version: 1, dirty: true };
          selected = draft.id;
          mobileEditor = true;
          render();
          notify('Recovered your last unsaved draft.');
          void flushSave();
        }
      }
    } catch { /* A malformed recovery draft does not block opening the notebook. */ }
    await initializeDiscovery(snapshot).catch(error => notify(`Your notes are ready. Nearby discovery: ${errorText(error)}`));
    setInterval(() => void refresh(), 3000);
  } catch (error) {
    app.innerHTML = `<main class="startup-error">${brand()}<h1>Couldn't open your notebook.</h1><p>${esc(errorText(error))}</p><button class="button primary" id="retry-start">Try again</button></main>`;
    document.querySelector('#retry-start')?.addEventListener('click', () => void start());
  }
}

void start();
