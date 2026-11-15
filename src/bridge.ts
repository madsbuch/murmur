import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { DraftBackup, FileContent, Network, PendingShare, Settings, Snapshot, Theme } from './types';
import { parseDraft, parseFileContent, parsePendingShares, parseSettings, parseSnapshot } from './validation';
import { createPreviewNetwork, parsePreviewInvitation, sameInvitationSecret } from './invitations';

export const native = isTauri();

interface PreviewState {
  deviceId: string;
  active: string | null;
  networks: Map<string, { network: Network; notes: Snapshot['notes']; files: Snapshot['files']; content: Map<string, FileContent> }>;
  drafts: Map<string, DraftBackup>;
  settings: Settings;
}

// The web preview is an ephemeral UI demonstration. All durable native data is
// owned by Rust/Diesel; the browser never creates a second persistent store.
const state: PreviewState = { deviceId: native ? '' : crypto.randomUUID(), active: null, networks: new Map(), drafts: new Map(), settings: { theme: 'system' } };

function activeNetwork() {
  const active = state.active === null ? undefined : state.networks.get(state.active);
  if (active === undefined) throw new Error('Create or join a network first.');
  return active;
}

function preview(): Snapshot {
  const active = state.active === null ? undefined : state.networks.get(state.active);
  return structuredClone({
    network: active?.network ?? null,
    notes: active?.notes ?? [], files: active?.files ?? [], heads: [],
    status: { peers: 0, lastSync: null, error: null },
    deviceId: state.deviceId, listenerPort: 0,
  });
}

async function snapshotCommand(command: string, args?: Record<string, unknown>): Promise<Snapshot> {
  return parseSnapshot(await invoke<unknown>(command, args));
}

export const api = {
  pendingShares: async (): Promise<PendingShare[]> => native ? parsePendingShares(await invoke<unknown>('get_pending_shares')) : [],
  importShares: async (networkId: string): Promise<Snapshot> => native ? snapshotCommand('import_pending_shares', { networkId }) : preview(),
  discardShares: async (): Promise<void> => { if (native) await invoke<unknown>('discard_pending_shares'); },
  listenForShares: async (received: () => void): Promise<() => void> => native ? listen<unknown>('share_received', received) : () => undefined,
  canScan: async (): Promise<boolean> => {
    if (!native) return false;
    const mobile = await invoke<unknown>('plugin:lan|is_mobile');
    if (typeof mobile !== 'boolean') throw new Error('Invalid platform response.');
    return mobile;
  },
  bootstrap: async (): Promise<Snapshot> => native ? snapshotCommand('bootstrap') : preview(),
  snapshot: async (): Promise<Snapshot> => native ? snapshotCommand('get_snapshot') : preview(),
  createNetwork: async (input: string): Promise<Snapshot> => {
    if (native) return snapshotCommand('create_network', { name: input });
    const name = input.trim();
    if (name.length === 0 || Array.from(name).length > 64) throw new Error('Choose a network name between 1 and 64 characters.');
    const network = await createPreviewNetwork(name);
    state.networks.set(network.id, { network, notes: [], files: [], content: new Map() });
    state.active = network.id;
    return preview();
  },
  joinNetwork: async (input: string): Promise<Snapshot> => {
    if (native) return snapshotCommand('join_network', { invite: input });
    const network = await parsePreviewInvitation(input.trim());
    const existing = state.networks.get(network.id);
    if (existing !== undefined && !sameInvitationSecret(existing.network, network)) throw new Error('This invitation does not match the saved network.');
    if (existing === undefined) state.networks.set(network.id, { network, notes: [], files: [], content: new Map() });
    state.active = network.id;
    return preview();
  },
  createNote: async (): Promise<Snapshot> => {
    if (native) return snapshotCommand('create_note');
    activeNetwork().notes.unshift({ id: crypto.randomUUID(), title: '', body: '', updatedAt: Date.now() });
    return preview();
  },
  updateNote: async (id: string, title: string, body: string, baseHeads: string[]): Promise<Snapshot> => {
    if (native) return snapshotCommand('update_note', { id, title, body, baseHeads });
    const note = activeNetwork().notes.find(n => n.id === id);
    if (note === undefined) throw new Error('This note no longer exists.');
    note.title = title;
    note.body = body;
    note.updatedAt = Date.now();
    return preview();
  },
  deleteNote: async (id: string): Promise<Snapshot> => {
    if (native) return snapshotCommand('delete_note', { id });
    const active = activeNetwork();
    active.notes = active.notes.filter(n => n.id !== id);
    return preview();
  },
  sync: async (): Promise<Snapshot> => native ? snapshotCommand('sync_now') : preview(),
  getSettings: async (): Promise<Settings> => native ? parseSettings(await invoke<unknown>('get_settings')) : structuredClone(state.settings),
  setTheme: async (theme: Theme): Promise<Settings> => {
    if (native) return parseSettings(await invoke<unknown>('set_theme', { theme }));
    state.settings = { theme };
    return structuredClone(state.settings);
  },
  importFile: async (networkId: string, content: FileContent): Promise<Snapshot> => {
    if (native) return snapshotCommand('import_file', { networkId, ...content });
    const active = activeNetwork();
    if (active.network.id !== networkId) throw new Error('The active network changed. Please choose your files again.');
    const bytes = Uint8Array.from(atob(content.dataBase64), char => char.charCodeAt(0));
    if (bytes.length > 25 * 1024 * 1024) throw new Error('Choose a file smaller than 25 MB.');
    if (active.files.length >= 500 || active.files.reduce((total, file) => total + file.size, 0) + bytes.length > 250 * 1024 * 1024) throw new Error('This network has reached its shared file limit. Delete some files first.');
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    if (state.active !== networkId) throw new Error('The active network changed. Please choose your files again.');
    const id = crypto.randomUUID();
    active.content.set(id, structuredClone(content));
    active.files.unshift({ id, name: content.name, mimeType: content.mimeType, size: bytes.length, sha256, createdAt: Date.now(), available: true });
    return preview();
  },
  readFile: async (networkId: string, id: string): Promise<FileContent> => {
    if (native) return parseFileContent(await invoke<unknown>('read_file', { networkId, id }));
    const active = activeNetwork();
    if (active.network.id !== networkId) throw new Error('The active network changed. Please select the file again.');
    const content = active.content.get(id);
    if (content === undefined) throw new Error('This file has not arrived yet.');
    return structuredClone(content);
  },
  deleteFile: async (networkId: string, id: string): Promise<Snapshot> => {
    if (native) return snapshotCommand('delete_file', { networkId, id });
    const active = activeNetwork();
    if (active.network.id !== networkId) throw new Error('The active network changed. Please select the file again.');
    active.files = active.files.filter(file => file.id !== id);
    active.content.delete(id);
    return preview();
  },
  getDraft: async (): Promise<DraftBackup | null> => {
    if (native) {
      const result = await invoke<unknown>('get_draft');
      return result === null ? null : parseDraft(result);
    }
    return structuredClone(state.active === null ? null : state.drafts.get(state.active) ?? null);
  },
  saveDraft: async (draft: DraftBackup): Promise<void> => {
    if (native) { await invoke<unknown>('save_draft', { draft }); return; }
    state.drafts.set(draft.networkId, structuredClone(draft));
  },
  importDraft: async (draft: DraftBackup): Promise<void> => {
    if (native) { await invoke<unknown>('import_draft', { draft }); return; }
    if (!state.drafts.has(draft.networkId)) state.drafts.set(draft.networkId, structuredClone(draft));
  },
  clearDraft: async (networkId: string, id: string): Promise<void> => {
    if (native) { await invoke<unknown>('clear_draft', { networkId, id }); return; }
    if (state.drafts.get(networkId)?.id === id) state.drafts.delete(networkId);
  },
};
