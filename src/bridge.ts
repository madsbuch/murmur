import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Network, Snapshot } from './types';

export const native = isTauri();
const key = 'murmur-browser-preview-v1';

interface PreviewState {
  deviceId: string;
  active: string | null;
  networks: Record<string, { network: Network; notes: Snapshot['notes'] }>;
}

function readPreview(): PreviewState {
  const stored = localStorage.getItem(key);
  if (stored) return JSON.parse(stored) as PreviewState;
  return { deviceId: crypto.randomUUID(), active: null, networks: {} };
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function createInvite(id: string, name: string): string {
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return `murmur://join#${base64url(new TextEncoder().encode(JSON.stringify({ v: 1, id, name, secret })))}`;
}

function parseInvite(invite: string): Network {
  if (invite.length > 4096 || !invite.startsWith('murmur://join#')) throw new Error('This is not a Murmur invitation.');
  try {
    const payload = invite.slice('murmur://join#'.length).replaceAll('-', '+').replaceAll('_', '/');
    const raw = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), c => c.charCodeAt(0))));
    if (raw.v !== 1 || typeof raw.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.id) || typeof raw.name !== 'string' || !raw.name.trim() || Array.from(raw.name).length > 64 || typeof raw.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.secret)) throw new Error();
    return { id: raw.id, name: raw.name, invite };
  } catch {
    throw new Error('The invitation is incomplete or invalid. Try scanning it again.');
  }
}

function preview(command: string, args: Record<string, unknown> = {}): Snapshot {
  const state = readPreview();
  if (command === 'create_network') {
    const name = String(args.name ?? '').trim();
    if (!name || Array.from(name).length > 64) throw new Error('Choose a network name between 1 and 64 characters.');
    const id = crypto.randomUUID();
    const network = { id, name, invite: createInvite(id, name) };
    state.networks[id] = { network, notes: [] };
    state.active = id;
  } else if (command === 'join_network') {
    const network = parseInvite(String(args.invite ?? '').trim());
    const existing = state.networks[network.id];
    if (existing && existing.network.invite !== network.invite) throw new Error('This invitation does not match the saved network.');
    state.networks[network.id] ??= { network, notes: [] };
    state.active = network.id;
  }
  const active = state.active ? state.networks[state.active] : undefined;
  if (command === 'create_note') {
    if (!active) throw new Error('Create or join a network first.');
    active.notes.unshift({ id: crypto.randomUUID(), title: '', body: '', updatedAt: Date.now() });
  } else if (command === 'update_note') {
    const note = active?.notes.find(n => n.id === args.id);
    if (!note) throw new Error('This note no longer exists.');
    note.title = String(args.title ?? '');
    note.body = String(args.body ?? '');
    note.updatedAt = Date.now();
  } else if (command === 'delete_note' && active) {
    active.notes = active.notes.filter(n => n.id !== args.id);
  }
  // A preview is intentionally a separate, browser-only store. Native persistence lives in Rust.
  localStorage.setItem(key, JSON.stringify(state));
  return {
    network: active?.network ?? null,
    notes: active?.notes ?? [],
    heads: [],
    status: { peers: 0, lastSync: null, error: null },
    deviceId: state.deviceId,
    listenerPort: 0,
  };
}

async function call(command: string, args?: Record<string, unknown>): Promise<Snapshot> {
  if (native) return invoke<Snapshot>(command, args);
  return preview(command, args);
}

export const api = {
  bootstrap: () => call('bootstrap'),
  snapshot: () => call('get_snapshot'),
  createNetwork: (name: string) => call('create_network', { name }),
  joinNetwork: (invite: string) => call('join_network', { invite }),
  createNote: () => call('create_note'),
  updateNote: (id: string, title: string, body: string, baseHeads: string[]) => call('update_note', { id, title, body, baseHeads }),
  deleteNote: (id: string) => call('delete_note', { id }),
  sync: () => call('sync_now'),
};
