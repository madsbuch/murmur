import type { Note, SharedFile } from './types';

export const MAX_TAG_CHARACTERS = 32;
export const MAX_TAGS_PER_ITEM = 32;

/** Keep identity and validation identical to the native Automerge tag fields. */
export function normalizeTag(raw: string): string {
  if (/[\p{Cc}\p{Cs}]/u.test(raw)) throw new Error('Tags cannot contain control characters.');
  const tag = raw.split(/\p{White_Space}+/u).filter(part => part.length > 0).join(' ').toLowerCase();
  if (tag.length === 0 || Array.from(tag).length > MAX_TAG_CHARACTERS) throw new Error('Choose a tag between 1 and 32 characters.');
  return tag;
}

function matchesTags(item: { tags: readonly string[] }, selectedTags: readonly string[]): boolean {
  return selectedTags.every(tag => item.tags.includes(tag));
}

function searchableText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** All search terms may match anywhere in the complete title or note body. */
export function filterNotes(notes: readonly Note[], query: string, selectedTags: readonly string[]): Note[] {
  const terms = searchableText(query).split(/\s+/u).filter(term => term.length > 0);
  return notes.filter(note => {
    if (!matchesTags(note, selectedTags)) return false;
    if (terms.length === 0) return true;
    const content = searchableText(note.title + '\n' + note.body);
    return terms.every(term => content.includes(term));
  });
}

export function filterFiles(files: readonly SharedFile[], selectedTags: readonly string[]): SharedFile[] {
  return files.filter(file => matchesTags(file, selectedTags));
}

export function availableTags(items: readonly { tags: readonly string[] }[]): string[] {
  return [...new Set(items.flatMap(item => item.tags))].sort((a, b) => a.localeCompare(b));
}
