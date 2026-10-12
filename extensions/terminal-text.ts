const stringSequence = /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)|(?:\x1b[P_^X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g;
const escapeSequence = /(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]?|\x1b[\x20-\x2f]*[\x30-\x7e]/g;
const suspect = /(?!\n)[\p{Cc}\p{Cf}\p{Cs}]/u;
const labelSuspect = /[\p{Cc}\p{Cf}\p{Cs}]|[^\S ]| {2}|^ | $/u;

export function terminalText(text: string): string {
  if (!suspect.test(text)) return text;
  return text.replace(stringSequence, '').replace(escapeSequence, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, char => char === '\n' ? '\n' : char === '\t' ? '    ' : ' ')
    .replace(/\p{Cs}/gu, '\uFFFD');
}

export function terminalLabel(text: string): string {
  if (!labelSuspect.test(text)) return text;
  return terminalText(text).replace(/\s+/g, ' ').trim();
}
