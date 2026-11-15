import type { DraftBackup, Network, Note, Snapshot } from './types';

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an object.');
  return { ...value };
}

export function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected text.');
  return value;
}

export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Expected a nonnegative safe integer.');
  return value;
}

export function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Expected a list of text.');
  return value.map((item: unknown) => text(item));
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'An unexpected error occurred. Please try again.';
}

function network(value: unknown): Network {
  const item = record(value);
  return { id: text(item['id']), name: text(item['name']), invite: text(item['invite']) };
}

function note(value: unknown): Note {
  const item = record(value);
  return { id: text(item['id']), title: text(item['title']), body: text(item['body']), updatedAt: integer(item['updatedAt']) };
}

export function parseSnapshot(value: unknown): Snapshot {
  const item = record(value);
  const status = record(item['status']);
  const notes = item['notes'];
  if (!Array.isArray(notes)) throw new Error('Expected a list of notes.');
  return {
    network: item['network'] === null ? null : network(item['network']),
    notes: notes.map((entry: unknown) => note(entry)),
    heads: strings(item['heads']),
    status: {
      peers: integer(status['peers']),
      lastSync: status['lastSync'] === null ? null : integer(status['lastSync']),
      error: status['error'] === null ? null : text(status['error']),
    },
    deviceId: text(item['deviceId']),
    listenerPort: integer(item['listenerPort']),
  };
}

export function parseDraft(value: unknown): DraftBackup {
  const item = record(value);
  const result = {
    networkId: text(item['networkId']), id: text(item['id']),
    title: text(item['title']), body: text(item['body']), baseHeads: strings(item['baseHeads']),
  };
  if (result.title.length > 1024 || result.body.length > 128 * 1024 || result.baseHeads.length > 4096) throw new Error('The saved draft exceeds the notebook size limit.');
  return result;
}
