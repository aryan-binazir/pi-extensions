export const maxSelectionChars = 50_000;

export function prefix(text: string, limit: number): string {
  let value = text.slice(0, Math.max(0, limit));
  if (value.length === text.length) return value;
  if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
  // UTF-16 copying detaches slices on V8 and JSC without replacing lone surrogates.
  return Buffer.from(value, 'utf16le').toString('utf16le');
}
