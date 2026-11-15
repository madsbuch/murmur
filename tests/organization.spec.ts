import { expect, test } from '@playwright/test';
import { availableTags, filterFiles, filterNotes, normalizeTag } from '../src/organization';
import { parseSnapshot, parseTags } from '../src/validation';
import { api } from '../src/bridge';
import type { Note, SharedFile } from '../src/types';

const notes: Note[] = [
  { id: 'cafe', title: 'Café plans', body: 'A short summary.\n' + 'More text. '.repeat(1000) + '\nMeet the guitarist after lunch.', updatedAt: 3, tags: ['music', 'work'] },
  { id: 'home', title: 'Lunch at home', body: 'Try a café recipe.', updatedAt: 2, tags: ['home'] },
  { id: 'song', title: 'Guitarist', body: '# Arrangement\n\nMeet the drummer.', updatedAt: 1, tags: ['music'] },
];

const files: SharedFile[] = [
  { id: 'track', name: 'Track.wav', mimeType: 'audio/wav', size: 100, sha256: 'hash', createdAt: 1, available: true, tags: ['music', 'work'] },
  { id: 'picture', name: 'Picture.png', mimeType: 'image/png', size: 100, sha256: 'hash', createdAt: 2, available: false, tags: ['home'] },
];

test('tag names normalize identity and enforce Unicode-aware limits', () => {
  expect(normalizeTag('  Field\u00a0\u2003NOTES  ')).toBe('field notes');
  expect(normalizeTag(' MUSIK ')).toBe('musik');
  expect(normalizeTag('🎵'.repeat(32))).toBe('🎵'.repeat(32));
  for (const invalid of ['', '   ', 'a\tb', 'a\nb', 'a\u007fb', 'a\u0085b', '\ud800', '🎵'.repeat(33)]) expect(() => normalizeTag(invalid)).toThrow();
});

test('snapshot tags accept old data and concurrent merges but reject malformed metadata', () => {
  expect(parseTags(undefined)).toEqual([]);
  expect(parseTags(['music', 'work'])).toEqual(['music', 'work']);
  expect(parseTags(Array.from({ length: 40 }, (_, index) => 'tag ' + index.toString()))).toHaveLength(40);
  for (const invalid of [null, 'music', [false], [''], ['Music'], ['music', 'music'], [' music '], ['a\tb']]) expect(() => parseTags(invalid)).toThrow();
  const legacy = {
    network: null,
    notes: [{ id: 'old-note', title: '', body: '', updatedAt: 1 }],
    files: [{ id: 'old-file', name: 'Old.txt', mimeType: 'text/plain', size: 1, sha256: 'hash', createdAt: 1, available: true }],
    heads: [], status: { peers: 0, lastSync: null, error: null }, deviceId: 'device', listenerPort: 0,
  };
  expect(parseSnapshot(legacy).notes[0]?.tags).toEqual([]);
  expect(parseSnapshot(legacy).files[0]?.tags).toEqual([]);
  expect(() => parseSnapshot({ ...legacy, notes: [{ ...legacy.notes[0], tags: [42] }] })).toThrow();
  expect(() => parseSnapshot({ ...legacy, files: [{ ...legacy.files[0], tags: ['Same', 'same'] }] })).toThrow();
});

test('note search scans complete titles and bodies and combines every term and selected tag', () => {
  expect(filterNotes(notes, 'CAFE guitarist', []).map(note => note.id)).toEqual(['cafe']);
  expect(filterNotes(notes, 'lunch café', []).map(note => note.id)).toEqual(['cafe', 'home']);
  expect(filterNotes(notes, 'MEET', ['music']).map(note => note.id)).toEqual(['cafe', 'song']);
  expect(filterNotes(notes, 'MEET', ['music', 'work']).map(note => note.id)).toEqual(['cafe']);
  expect(filterNotes(notes, 'arrangement', []).map(note => note.id)).toEqual(['song']);
  expect(filterNotes(notes, 'nothing matches', [])).toEqual([]);
  expect(filterNotes(notes, ' \n\t ', [])).toEqual(notes);
  expect(filterNotes(notes, '', ['unknown'])).toEqual([]);
});

test('file filters include pending files, require every selected tag and share available labels with notes', () => {
  expect(filterFiles(files, ['music', 'work']).map(file => file.id)).toEqual(['track']);
  expect(filterFiles(files, ['home']).map(file => file.id)).toEqual(['picture']);
  expect(filterFiles(files, ['home', 'music'])).toEqual([]);
  expect(filterFiles(files, [])).toEqual(files);
  expect(availableTags([...notes, ...files])).toEqual(['home', 'music', 'work']);
});

test('browser tag actions preserve content, normalize duplicates and remain scoped to their network', async () => {
  const network = (await api.createNetwork('Tag adapter test')).network;
  if (network === null) throw new Error('Missing test network');
  const note = (await api.createNote()).notes[0];
  if (note === undefined) throw new Error('Missing test note');
  const saved = (await api.updateNote(note.id, 'Working title', 'Keep this Markdown **source**.', [])).notes[0];
  const file = (await api.importFile(network.id, { name: 'Track.txt', mimeType: 'text/plain', dataBase64: 'bXVzaWM=' })).files[0];
  if (saved === undefined || file === undefined) throw new Error('Missing test items');
  await api.setTag(network.id, 'note', note.id, ' MUSIC ', true);
  await api.setTag(network.id, 'note', note.id, 'music', true);
  let snapshot = await api.setTag(network.id, 'file', file.id, ' Music ', true);
  expect(snapshot.notes[0]).toEqual({ ...saved, tags: ['music'] });
  expect(snapshot.files[0]).toEqual({ ...file, tags: ['music'] });
  expect(await api.readFile(network.id, file.id)).toEqual({ name: 'Track.txt', mimeType: 'text/plain', dataBase64: 'bXVzaWM=' });
  snapshot = await api.setTag(network.id, 'note', note.id, 'music', false);
  expect(snapshot.notes[0]).toEqual(saved);
  await api.createNetwork('A different network');
  await expect(api.setTag(network.id, 'file', file.id, 'wrong destination', true)).rejects.toThrow('active network changed');
  snapshot = await api.joinNetwork(network.invite);
  expect(snapshot.files[0]?.tags).toEqual(['music']);
  await expect(api.setTag(network.id, 'note', 'missing-note', 'music', true)).rejects.toThrow('no longer exists');
});
