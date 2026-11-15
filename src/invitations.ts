import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { Network } from './types';
import { record, text } from './validation';

const invitePrefix = 'murmur://join#';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64url(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
}

function uuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('Expected a 16-byte network ID.');
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

function uuidBytes(id: string): Uint8Array<ArrayBuffer> {
  if (!uuidPattern.test(id)) throw new Error('Invalid network ID.');
  const hex = id.replaceAll('-', '');
  return Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

async function derivedId(secret: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode('murmur-network-id-v2\u0000');
  const bytes = new Uint8Array(prefix.length + secret.length);
  bytes.set(prefix);
  bytes.set(secret, prefix.length);
  return uuid(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 16));
}

function readLink(input: string): { id: string; name: string; secret: string } {
  const decoded: unknown = JSON.parse(new TextDecoder().decode(decodeBase64url(input.slice(invitePrefix.length))));
  const fields = record(decoded);
  const id = text(fields['id']);
  const name = text(fields['name']);
  const secret = text(fields['secret']);
  if (fields['v'] !== 1 || !uuidPattern.test(id) || name.trim().length === 0 || Array.from(name).length > 64 || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('Invalid invitation.');
  return { id: id.toLowerCase(), name, secret };
}

function link(id: string, name: string, secret: Uint8Array): string {
  return invitePrefix + base64url(new TextEncoder().encode(JSON.stringify({ v: 1, id, name, secret: base64url(secret) })));
}

async function network(id: string, name: string, secret: Uint8Array): Promise<Network> {
  const words = entropyToMnemonic(secret, wordlist);
  const phrase = id === await derivedId(secret) ? words : entropyToMnemonic(uuidBytes(id), wordlist) + ' ' + words;
  return { id, name, invite: link(id, name, secret), phrase };
}

export async function createPreviewNetwork(name: string): Promise<Network> {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  return network(await derivedId(secret), name, secret);
}

export async function parsePreviewInvitation(input: string): Promise<Network> {
  if (input.length > 4096 || (input.includes('://') && !input.startsWith(invitePrefix))) throw new Error('This is not a Murmur invitation.');
  try {
    if (input.startsWith(invitePrefix)) {
      const payload = readLink(input);
      return await network(payload.id, payload.name, decodeBase64url(payload.secret));
    }
    const words = input.toLowerCase().trim().split(/[\s-]+/).map(word => {
      if (wordlist.includes(word)) return word;
      if (word.length !== 4) throw new Error('Unknown invitation word.');
      const matches = wordlist.filter(candidate => candidate.startsWith(word));
      const match = matches[0];
      if (matches.length !== 1 || match === undefined) throw new Error('Unknown invitation word.');
      return match;
    });
    if (words.length !== 24 && words.length !== 36) throw new Error('Expected 24 or 36 words.');
    const secret = mnemonicToEntropy(words.slice(-24).join(' '), wordlist);
    const id = words.length === 24 ? await derivedId(secret) : uuid(mnemonicToEntropy(words.slice(0, 12).join(' '), wordlist));
    return await network(id, 'Shared network', secret);
  } catch {
    throw new Error('The invitation is incomplete or invalid. Check the words or scan the QR code again.');
  }
}

export function sameInvitationSecret(first: Network, second: Network): boolean {
  return first.id === second.id && readLink(first.invite).secret === readLink(second.invite).secret;
}
