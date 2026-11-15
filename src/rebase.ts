import { diffArrays, diffChars } from 'diff';

/** Reapply keystrokes entered during a save without erasing arriving peer text. */
export function rebaseDraft(base: string, local: string, remote: string): string {
  if (base === local) return remote;
  if (base === remote) return local;
  const chars = Array.from(base);
  function edits(next: string) {
    const removed = new Set<number>();
    const added = new Map<number, string[]>();
    let offset = 0;
    for (const part of diffArrays(chars, Array.from(next))) {
      if (part.added === true) added.set(offset, [...(added.get(offset) ?? []), ...part.value]);
      else if (part.removed === true) for (let i = 0; i < part.value.length; i++) removed.add(offset++);
      else offset += part.value.length;
    }
    return { removed, added };
  }
  const own = edits(local);
  const peer = edits(remote);
  const result: string[] = [];
  for (let i = 0; i <= chars.length; i++) {
    result.push(...(peer.added.get(i) ?? []), ...(own.added.get(i) ?? []));
    const char = chars[i];
    if (char !== undefined && !own.removed.has(i) && !peer.removed.has(i)) result.push(char);
  }
  return result.join('');
}

/** Translate a textarea's UTF-16 caret across merged changes. */
export function mapCaret(before: string, after: string, caret: number): number {
  let oldOffset = 0;
  let newOffset = 0;
  for (const part of diffChars(before, after)) {
    if (part.added === true) newOffset += part.value.length;
    else if (part.removed === true) {
      if (caret <= oldOffset + part.value.length) return newOffset;
      oldOffset += part.value.length;
    } else {
      if (caret <= oldOffset + part.value.length) return newOffset + caret - oldOffset;
      oldOffset += part.value.length;
      newOffset += part.value.length;
    }
  }
  return newOffset;
}
