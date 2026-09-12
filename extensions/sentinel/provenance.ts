import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { digest } from './config.ts';

const MAX_INPUT = 128000;
const OMITTED = '\n<sentinel_omitted reason="input_budget" />';

/** Capture the input event before Pi expands commands, skills, or templates. */
export function captureUserInput(event: { source?: string; text: string; images?: Array<{ data: string; mimeType: string }> }): unknown | undefined {
  if (event.source !== 'interactive' && event.source !== 'rpc') return undefined;
  let complete = event.text.length <= MAX_INPUT;
  const text = complete ? event.text : event.text.slice(0, MAX_INPUT - OMITTED.length) + OMITTED;
  // Bound metadata too; image bytes are referenced, never copied into authorization.
  const images = (event.images ?? []).slice(0, 128).map(image => {
    if (image.mimeType.length > 256) complete = false;
    return { sha256: digest(image.data), mimeType: image.mimeType.slice(0, 256) };
  });
  if ((event.images?.length ?? 0) > images.length) complete = false;
  return { text, images, complete };
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown, min: number, max: number): value is string => typeof value === 'string' && value.length >= min && value.length <= max;
// Keep exactly the questionnaire renderer's cleanup; spaces, tabs, and newlines are meaningful.
const clean = (text: string): string => stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

/** Only the displayed choice or the user's own text is verified authority. */
export function sanitizeQuestionnaire(input: unknown, result: unknown): { verified_answers: unknown[]; assistant_authored_questions: unknown } | undefined {
  try {
    if (!record(input) || !Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 12 ||
        !record(result) || result.cancelled !== false || !Array.isArray(result.answers) || result.answers.length !== input.questions.length) return undefined;
    const ids = new Set<string>();
    const verified_answers: unknown[] = [];
    for (const [question_index, question] of input.questions.entries()) {
      if (!record(question) || !string(question.id, 1, 80) || ids.has(question.id) || !string(question.prompt, 1, 4000) ||
          (question.label !== undefined && !string(question.label, 0, 80)) ||
          (question.allowOther !== undefined && typeof question.allowOther !== 'boolean') ||
          !Array.isArray(question.options) || question.options.length > 20 || (!question.options.length && question.allowOther === false)) return undefined;
      ids.add(question.id);
      for (const option of question.options) {
        if (!record(option) || !string(option.value, 0, 1000) || !string(option.label, 1, 1000) ||
            (option.description !== undefined && !string(option.description, 0, 2000))) return undefined;
      }
      // The actual UI submits one answer per question in declaration order.
      const answer: unknown = result.answers[question_index];
      if (!record(answer) || answer.id !== question.id || typeof answer.wasCustom !== 'boolean' ||
          typeof answer.label !== 'string' || typeof answer.value !== 'string') return undefined;
      if (answer.wasCustom) {
        if (question.allowOther === false || answer.label !== answer.value || !answer.value.trim() || answer.value.length > 16000) return undefined;
        verified_answers.push({ question_index, text: clean(answer.value) });
      } else {
        if (!question.options.some(option => option.value === answer.value && option.label === answer.label)) return undefined;
        verified_answers.push({ question_index, label: clean(answer.label) });
      }
    }
    return { verified_answers, assistant_authored_questions: input };
  } catch { return undefined; }
}

interface InstructionOptions {
  customPrompt?: string;
  appendSystemPrompt?: string;
  contextFiles?: Array<{ path: string; content: string }>;
}
const contained = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

/** File paths establish provenance; prompt strings alone cannot establish their source. */
export async function classifyInstructions(options: InstructionOptions | undefined, projectTrusted: boolean, agentDir: string): Promise<{ trusted: string; untrusted: string }> {
  const trusted: Record<string, unknown> = {};
  const untrusted: Record<string, unknown> = {};
  let globalDir: string | undefined;
  try {
    const canonical = await realpath(agentDir);
    // A redirected global root cannot prove that the target is globally user-owned.
    if (canonical === resolve(agentDir) && (await stat(canonical)).isDirectory()) globalDir = canonical;
  } catch { /* Missing global paths do not establish trust. */ }
  for (const key of ['customPrompt', 'appendSystemPrompt'] as const) {
    if (options?.[key] !== undefined) (projectTrusted ? trusted : untrusted)[key] = options[key];
  }
  for (const file of options?.contextFiles ?? []) {
    let globallyOwned = false;
    if (globalDir && isAbsolute(file.path) && contained(globalDir, resolve(file.path))) {
      try {
        const canonical = await realpath(file.path);
        globallyOwned = contained(globalDir, canonical) && (await stat(canonical)).isFile();
      } catch { /* Missing or dangling files cannot establish global ownership. */ }
    }
    const target = projectTrusted || globallyOwned ? trusted : untrusted;
    const files = (target.contextFiles ??= []) as Array<{ path: string; content: string }>;
    files.push({ path: file.path, content: file.content });
  }
  return {
    trusted: Object.keys(trusted).length ? JSON.stringify(trusted) : '',
    untrusted: Object.keys(untrusted).length ? JSON.stringify({ untrusted_instructions: untrusted }) : '',
  };
}
