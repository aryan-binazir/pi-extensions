import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { digest } from './config.ts';

export interface RootAuthorization { instructions: string; users: unknown[]; complete: boolean }
export interface EvidenceImage { type: 'image'; data: string; mimeType: string }
interface RecordEntry { role: string; content: unknown }
const MARKER = '<sentinel_truncated reason="context_budget" />';
export const MAX_USERS = 128000;
export const MAX_INSTRUCTIONS = 128000;
const MAX_HISTORY = 64000;
const MAX_ENTRY = 16000;
const bounded = (text: string, size: number) => text.length <= size ? text : `${text.slice(0, Math.max(0, size - MARKER.length))}${MARKER}`;

/** User authorization is retained independently of the rolling execution window. */
export function collectEvidence(ctx: ExtensionContext, instructions: string, inherited?: RootAuthorization) {
  const rawUsers: unknown[] = [];
  const records: RecordEntry[] = [];
  const images: EvidenceImage[] = [];
  const imageHashes: string[] = [];
  const reasons = new Set<string>();
  let imageBytes = 0;
  let authorizationHasImages = false;
  const content = (value: unknown, authorization = false): unknown => {
    if (!Array.isArray(value)) return value;
    return value.map((block: unknown) => {
      if (!block || typeof block !== 'object' || !('type' in block) || block.type !== 'image') return block;
      const record = block as Record<string, unknown>;
      const source = record.source as Record<string, unknown> | undefined;
      const data = source?.data ?? record.data;
      const mimeType = source?.mediaType ?? record.mimeType;
      if (authorization) authorizationHasImages = true;
      if (typeof data !== 'string' || typeof mimeType !== 'string') { reasons.add('unsupported_image'); return '[unsupported image omitted]'; }
      const hash = digest(data);
      if (!imageHashes.includes(hash)) {
        if (images.length >= 4 || imageBytes + data.length > 4 * 1024 * 1024) { reasons.add('image_budget'); return { type: 'omitted-image', sha256: hash }; }
        imageBytes += data.length;
        images.push({ type: 'image', data, mimeType }); imageHashes.push(hash);
      }
      return { type: 'image-reference', sha256: hash };
    });
  };
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === 'message') {
      const message = entry.message;
      const value = 'content' in message ? message.content : message;
      if (message.role === 'user' && !inherited) rawUsers.push(value);
      else records.push({ role: message.role === 'user' ? 'delegated_task' : message.role, content: value });
    } else if (entry.type === 'custom' && entry.customType === 'sentinel:user-answer' && !inherited) {
      const data = entry.data as { verified_answers?: unknown; assistant_authored_questions?: unknown } | undefined;
      if (Array.isArray(data?.verified_answers)) {
        // The question's assertions belong to the assistant, even when the user answers it.
        rawUsers.push({ verified_answers: data.verified_answers });
        records.push({ role: 'assistant_authored_questions', content: data.assistant_authored_questions });
      }
    } else if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      records.push({ role: 'untrusted_summary', content: entry.summary });
    }
  }
  let historySize = 0;
  const recent: RecordEntry[] = [];
  // Reserve image slots for current evidence before old screenshots; older history is intentional omission.
  for (const record of records.slice(-20).reverse()) {
    const raw = JSON.stringify(content(record.content));
    const rendered = bounded(raw, MAX_ENTRY);
    if (rendered !== raw) reasons.add('execution_entry_budget');
    if (historySize + rendered.length > MAX_HISTORY) { reasons.add('execution_history_budget'); break; }
    historySize += rendered.length;
    recent.unshift({ role: record.role, content: rendered });
  }
  const users = inherited?.users ?? rawUsers.map(value => content(value, true));
  const trustedInstructions = inherited?.instructions ?? instructions;
  const rawUserText = JSON.stringify(users);
  if (rawUserText.length > MAX_USERS) reasons.add('user_authorization_budget');
  if (trustedInstructions.length > MAX_INSTRUCTIONS) reasons.add('instruction_budget');
  if (inherited?.complete === false) reasons.add('inherited_authorization_incomplete');
  const authComplete = (inherited?.complete ?? true) && rawUserText.length <= MAX_USERS && trustedInstructions.length <= MAX_INSTRUCTIONS;
  const authorization: RootAuthorization = {
    instructions: bounded(trustedInstructions, MAX_INSTRUCTIONS),
    users: rawUserText.length <= MAX_USERS ? users : [{ omitted_user_messages: bounded(rawUserText, MAX_USERS) }],
    // Child snapshots intentionally contain no image payloads. They must not claim complete visual authorization.
    complete: authComplete && !authorizationHasImages,
  };
  const complete = reasons.size === 0;
  const text = JSON.stringify({
    root_authorization: inherited ? JSON.stringify(authorization) : undefined,
    trusted_instructions: inherited ? undefined : authorization.instructions,
    trusted_user_messages: inherited ? undefined : JSON.stringify(authorization.users),
    evidence: recent, image_order: imageHashes,
    history_window: 'Last 20 non-user entries; older execution evidence may be omitted.',
    complete, incomplete_reasons: [...reasons],
  });
  return { text, images, complete, incompleteReasons: [...reasons], authorization, identity: digest({ authorization, complete }) };
}
