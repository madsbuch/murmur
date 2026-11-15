import { invoke, isTauri } from '@tauri-apps/api/core';
import type { DraftBackup, Network, Snapshot } from './types';
import { parseDraft, parseSnapshot, record, text } from './validation';

export const native = isTauri();

interface PreviewState {
  deviceId: string;
  active: string | null;
  networks: Map<string, { network: Network; notes: Snapshot['notes'] }>;
  drafts: Map<string, DraftBackup>;
}

// The web preview is an ephemeral UI demonstration. All durable native data is
// owned by Rust/Diesel; the browser never creates a second persistent store.
const state: PreviewState = { deviceId: crypto.randomUUID(), active: null, networks: new Map(), drafts: new Map() };

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function createInvite(id: string, name: string): string {
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return 'murmur://join#' + base64url(new TextEncoder().encode(JSON.stringify({ v: 1, id, name, secret })));
}

function parseInvite(invite: string): Network {
  if (invite.length > 4096 || !invite.startsWith('murmur://join#')) throw new Error('This is not a Murmur invitation.');
  try {
    const payload = invite.slice('murmur://join#'.length).replaceAll('-', '+').replaceAll('_', '/');
    const raw: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), c => c.charCodeAt(0))));
    const fields = record(raw);
    const id = text(fields['id']);
    const name = text(fields['name']);
    const secret = text(fields['secret']);
    if (fields['v'] !== 1 || !/^[0-9a-f-]{36}$/i.test(id) || name.trim().length === 0 || Array.from(name).length > 64 || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('Invalid invitation.');
    return { id, name, invite };
  } catch {
    throw new Error('The invitation is incomplete or invalid. Try scanning it again.');
  }
}

function activeNetwork() {
  const active = state.active === null ? undefined : state.networks.get(state.active);
  if (active === undefined) throw new Error('Create or join a network first.');
  return active;
}

function preview(): Snapshot {
  const active = state.active === null ? undefined : state.networks.get(state.active);
  return structuredClone({
    network: active?.network ?? null,
    notes: active?.notes ?? [], heads: [],
    status: { peers: 0, lastSync: null, error: null },
    deviceId: state.deviceId, listenerPort: 0,
  });
}

async function snapshotCommand(command: string, args?: Record<string, unknown>): Promise<Snapshot> {
  return parseSnapshot(await invoke<unknown>(command, args));
}

export const api = {
  bootstrap: async (): Promise<Snapshot> => native ? snapshotCommand('bootstrap') : preview(),
  snapshot: async (): Promise<Snapshot> => native ? snapshotCommand('get_snapshot') : preview(),
  createNetwork: async (input: string): Promise<Snapshot> => {
    if (native) return snapshotCommand('create_network', { name: input });
    const name = input.trim();
    if (name.length === 0 || Array.from(name).length > 64) throw new Error('Choose a network name between 1 and 64 characters.');
    const id = crypto.randomUUID();
    state.networks.set(id, { network: { id, name, invite: createInvite(id, name) }, notes: [] });
    state.active = id;
    return preview();
  },
  joinNetwork: async (input: string): Promise<Snapshot> => {
    if (native) return snapshotCommand('join_network', { invite: input });
    const network = parseInvite(input.trim());
    const existing = state.networks.get(network.id);
    if (existing !== undefined && existing.network.invite !== network.invite) throw new Error('This invitation does not match the saved network.');
    if (existing === undefined) state.networks.set(network.id, { network, notes: [] });
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
