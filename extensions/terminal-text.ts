import { stripVTControlCharacters } from 'node:util';

const stringSequence = /(?:\x1b[\]P_^X]|[\x90\x98\x9d-\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g;
const suspect = /(?!\n)[\p{Cc}\p{Cf}\p{Cs}]/u;
const labelSuspect = /[\p{Cc}\p{Cf}\p{Cs}]|[^\S ]| {2}|^ | $/u;

export function terminalText(text: string): string {
  if (!suspect.test(text)) return text;
  return stripVTControlCharacters(text.replace(stringSequence, ''))
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, char => char === '\n' ? '\n' : char === '\t' ? '    ' : ' ')
    .replace(/\p{Cs}/gu, '\uFFFD');
}

export function terminalLabel(text: string): string {
  if (!labelSuspect.test(text)) return text;
  return terminalText(text).replace(/\s+/g, ' ').trim();
}
