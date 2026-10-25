import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { terminalLabel } from '../terminal-text.ts';

export const MAX_CONTEXT = 12000;
export const MAX_MESSAGE = 3000;
export const MAX_MESSAGES = 24;

export function messageText(message: { role: string; content?: unknown }): string {
  if (message.role !== 'user' && message.role !== 'assistant') return '';
  if (typeof message.content === 'string') return message.content.slice(0, MAX_MESSAGE).trim();
  if (!Array.isArray(message.content)) return '';
  let text = '';
  for (const block of message.content) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text.slice(0, MAX_MESSAGE - text.length);
    if (text.length >= MAX_MESSAGE) break;
  }
  return text.trim();
}

export function conversationText(branch: readonly SessionEntry[], extra?: { role: string; content?: unknown }): string {
  const parts: string[] = [];
  let remaining = MAX_CONTEXT;
  const add = (message: { role: string; content?: unknown }) => {
    const text = messageText(message);
    if (!text) return;
    const part = `${message.role}: ${text}`.slice(0, remaining);
    parts.unshift(part);
    remaining -= part.length + 2;
  };
  if (extra) add(extra);
  for (let i = branch.length - 1; i >= 0 && remaining > 0 && parts.length < MAX_MESSAGES; i--) {
    const entry = branch[i];
    if (entry.type === 'message') add(entry.message);
  }
  return parts.join('\n\n');
}

export function normalizeTitle(raw: string): string {
  const unquote = (text: string) => text.replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, '').trim();
  let text = unquote(unquote(terminalLabel(raw)).replace(/^(?:title|session name|name)\s*:\s*/i, ''));
  text = text.split(/\s+/u).slice(0, 6).join(' ');
  if ([...text].length > 60) {
    const prefix = [...text].slice(0, 60).join('');
    const boundary = prefix.lastIndexOf(' ');
    text = boundary > 0 ? prefix.slice(0, boundary) : prefix;
  }
  if (!text) throw new Error('provider returned an empty title');
  return text;
}
