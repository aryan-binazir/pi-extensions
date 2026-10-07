export const maxSelectionChars = 50_000;

export function prefix(text: string, limit: number): string {
  const value = text.slice(0, Math.max(0, limit));
  return value.length < text.length && /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value;
}
