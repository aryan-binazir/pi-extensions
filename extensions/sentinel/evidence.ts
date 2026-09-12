import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { digest } from './config.ts';

export interface RootAuthorization { instructions: string; users: unknown[]; complete: boolean }
export interface EvidenceImage { type: 'image'; data: string; mimeType: string }
interface RecordEntry { role: string; content: unknown }
const MARKER = '<sentinel_truncated reason="context_budget" />';
export const MAX_USERS = 128000;
export const MAX_INSTRUCTIONS = 128000;
const MAX_HISTORY = 196608;
const MAX_ENTRY = 65536;
const bounded = (text: string, size: number) => text.length <= size ? text : `${text.slice(0, Math.max(0, size - MARKER.length))}${MARKER}`.slice(0, size);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Original input provenance is separate from Pi's expanded user-role messages. */
export function collectEvidence(ctx: ExtensionContext, instructions: string, inherited?: RootAuthorization, untrustedInstructions = '') {
  const rawUsers: unknown[] = [];
  const records: RecordEntry[] = [];
  const externalSteering: unknown[] = [];
  const userImageSources: unknown[] = [];
  const authorizedImages = new Set<string>();
  const images: EvidenceImage[] = [], imageHashes: string[] = [];
  const reasons = new Set<string>();
  let imageBytes = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === 'message') {
      const message = entry.message;
      const value = 'content' in message ? message.content : message;
      const role = message.role === 'user' ? inherited ? 'delegated_task' : 'unverified_user_message' : message.role;
      records.push({ role, content: value });
      if (message.role === 'user') { externalSteering.push(digest({ role: message.role, content: value })); userImageSources.push(value); }
    } else if (entry.type === 'custom_message') {
      const value = { customType: entry.customType, content: entry.content };
      records.push({ role: 'untrusted_custom_message', content: entry.content }); externalSteering.push(digest({ role: 'custom_message', ...value }));
    } else if (entry.type === 'custom' && !inherited) {
      const data = entry.data;
      if (entry.customType === 'sentinel:user-input' && object(data) && data.version === 1 && object(data.input) && typeof data.input.text === 'string') {
        const input = data.input;
        const refs = Array.isArray(input.images) ? input.images.filter(object).filter(image => typeof image.sha256 === 'string').map(image => ({ sha256: image.sha256 as string, mimeType: image.mimeType })) : [];
        refs.forEach(image => authorizedImages.add(image.sha256));
        rawUsers.push({ text: input.text, images: refs });
        if (input.complete !== true) reasons.add('user_input_omitted');
      } else if (entry.customType === 'sentinel:user-answer' && object(data)) {
        records.push({ role: 'assistant_authored_questions', content: data.assistant_authored_questions ?? data });
        if (data.version === 2 && Array.isArray(data.verified_answers)) {
          // Do not restore hidden option values or textual IDs from legacy entries.
          const answers = data.verified_answers.filter(object).filter(answer => Number.isInteger(answer.question_index) && (typeof answer.label === 'string' || typeof answer.text === 'string'))
            .map(answer => ({ question_index: answer.question_index, ...(typeof answer.text === 'string' ? { text: answer.text } : { label: answer.label }) }));
          if (answers.length) rawUsers.push({ verified_answers: answers });
        }
      }
    } else if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      records.push({ role: 'untrusted_summary', content: entry.summary });
    }
  }
  const content = (value: unknown, onlyAuthorized = false): unknown => {
    if (!Array.isArray(value)) return value;
    return value.map((block: unknown) => {
      if (!object(block) || block.type !== 'image') return block;
      const source = object(block.source) ? block.source : undefined;
      const data = source?.data ?? block.data, mimeType = source?.mediaType ?? block.mimeType;
      if (typeof data !== 'string' || typeof mimeType !== 'string') { reasons.add('unsupported_image'); return '[unsupported image omitted]'; }
      const hash = digest(data);
      if (onlyAuthorized && !authorizedImages.has(hash)) return block;
      if (!imageHashes.includes(hash)) {
        if (images.length >= 4 || imageBytes + data.length > 4 * 1024 * 1024) { reasons.add('image_budget'); return { type: 'omitted-image', sha256: hash }; }
        imageBytes += data.length; images.push({ type: 'image', data, mimeType }); imageHashes.push(hash);
      }
      return { type: 'image-reference', sha256: hash };
    });
  };
  // User-supplied visual authority gets slots before tool screenshots, newest first.
  for (const value of userImageSources.reverse()) content(value, true);
  if ([...authorizedImages].some(hash => !imageHashes.includes(hash))) reasons.add('authorization_image_unavailable');
  let historySize = 0, historyTrimmedByBytes = false;
  const recent: RecordEntry[] = [];
  for (const record of records.slice(-20).reverse()) {
    const raw = JSON.stringify(content(record.content));
    const rendered = bounded(raw, MAX_ENTRY);
    // Byte and count limits both trim the oldest part of the execution window.
    if (historySize + rendered.length > MAX_HISTORY) { historyTrimmedByBytes = true; break; }
    if (rendered !== raw) reasons.add('execution_entry_budget');
    historySize += rendered.length; recent.unshift({ role: record.role, content: rendered });
  }
  if (!inherited && !rawUsers.length && userImageSources.length) reasons.add('user_input_provenance_unavailable');
  const users = inherited?.users ?? rawUsers;
  const trustedInstructions = inherited?.instructions ?? instructions;
  const rawUserText = JSON.stringify(users);
  if (rawUserText.length > MAX_USERS) reasons.add('user_authorization_budget');
  if (trustedInstructions.length > MAX_INSTRUCTIONS) reasons.add('instruction_budget');
  if (untrustedInstructions.length > MAX_INSTRUCTIONS) reasons.add('steering_instruction_budget');
  if (inherited?.complete === false) reasons.add('inherited_authorization_incomplete');
  const authComplete = (inherited?.complete ?? true) && rawUserText.length <= MAX_USERS && trustedInstructions.length <= MAX_INSTRUCTIONS && !reasons.has('user_input_omitted') && !reasons.has('user_input_provenance_unavailable');
  const authorization: RootAuthorization = {
    instructions: bounded(trustedInstructions, MAX_INSTRUCTIONS),
    users: rawUserText.length <= MAX_USERS ? users : [{ omitted_user_messages: bounded(rawUserText, MAX_USERS) }],
    complete: authComplete && authorizedImages.size === 0,
  };
  const complete = reasons.size === 0;
  const text = JSON.stringify({
    root_authorization: inherited ? JSON.stringify(authorization) : undefined,
    trusted_instructions: inherited ? undefined : authorization.instructions,
    trusted_user_messages: inherited ? undefined : JSON.stringify(authorization.users),
    untrusted_instructions: bounded(untrustedInstructions, MAX_INSTRUCTIONS),
    evidence: recent, image_order: imageHashes,
    history_window: { max_entries: 20, max_characters: MAX_HISTORY, trimmed_by_bytes: historyTrimmedByBytes, older_entries_omitted: recent.length < records.length },
    complete, incomplete_reasons: [...reasons],
  });
  return { text, images, complete, incompleteReasons: [...reasons], authorization, identity: digest({ authorization, complete, externalSteering, untrustedInstructions }) };
}
