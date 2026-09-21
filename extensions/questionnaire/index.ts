import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const parameters = Type.Object({
  questions: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 80 }),
      label: Type.Optional(Type.String({ maxLength: 80 })),
      prompt: Type.String({ minLength: 1, maxLength: 4000 }),
      options: Type.Array(
        Type.Object({
          value: Type.String({ maxLength: 1000 }),
          label: Type.String({ minLength: 1, maxLength: 1000 }),
          description: Type.Optional(Type.String({ maxLength: 2000 })),
        }),
        { maxItems: 20 },
      ),
      allowOther: Type.Optional(Type.Boolean()),
    }),
    { minItems: 1, maxItems: 12 },
  ),
});
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const clean = (text: string) =>
  stripTerminalSequences(text).replace(CONTROL_CHARS, "");
/** Rendered-text caches are keyed by fully styled strings, so a theme or width
 * change produces new keys rather than stale frames. Bounded so a questionnaire
 * walked across many tabs cannot retain more than a few screens of text. */
const CACHE_LIMIT = 64;
const memo = <T>(cache: Map<string, T>, key: string, build: () => T): T => {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (cache.size >= CACHE_LIMIT) cache.clear();
  const value = build();
  cache.set(key, value);
  return value;
};

interface Answer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
}
interface Result {
  cancelled: boolean;
  answers: Answer[];
  reason?: string;
}

/** Waiting notifications are paired by toolCallId. */
export default function questionnaire(pi: ExtensionAPI) {
  const active = new Set<() => void>();
  let inFlight = false;
  pi.on("session_shutdown", () => {
    for (const cancel of active) cancel();
  });
  pi.registerTool({
    name: "questionnaire",
    label: "Questionnaire",
    description:
      "Ask the user questions with options or free text. Interactive terminal only. Multiple questions require final submission. Cancellation is explicit.",
    parameters,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const finish = (result: Result) => ({
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      });
      if (ctx.mode !== "tui")
        return finish({
          cancelled: true,
          answers: [],
          reason: "Interactive terminal required",
        });
      if (
        !params.questions.length ||
        new Set(params.questions.map((q) => q.id)).size !==
          params.questions.length ||
        params.questions.some(
          (q) => !q.options.length && q.allowOther === false,
        )
      ) {
        return finish({
          cancelled: true,
          answers: [],
          reason: "Questions require unique IDs and an available answer",
        });
      }
      if (signal?.aborted)
        return finish({ cancelled: true, answers: [], reason: "Aborted" });
      if (inFlight)
        return finish({
          cancelled: true,
          answers: [],
          reason: "A questionnaire is already active",
        });
      let cancel = () => {};
      try {
        inFlight = true;
        pi.events.emit("pi-interactive:questionnaire-waiting", {
          toolCallId,
          waiting: true,
        });
        const result = await ctx.ui.custom<Result>(
          (tui, theme, _keys, done) => {
            let tab = 0;
            let selected = 0;
            let editing = false;
            let settled = false;
            const answers = new Map<string, Answer>();
            // Sanitising and laying out question text is width-independent, so
            // do it once per questionnaire instead of once per keystroke.
            const cleanAnswers = new Map<string, string>();
            const labels = params.questions.map((item) =>
              clean(item.label || item.id),
            );
            const tabLabel = (index: number) =>
              `${answers.has(params.questions[index].id) ? "✓ " : ""}${labels[index]}`;
            const bodies: {
              prompt: string;
              optionRows: { suffix: string; description?: string }[];
            }[] = [];
            const bodyFor = (index: number) => {
              const cached = bodies[index];
              if (cached) return cached;
              const item = params.questions[index];
              const optionRows = item.options.map((option, i) => ({
                suffix: ` ${i + 1}. ${clean(option.label)}`,
                description: option.description
                  ? `     ${clean(option.description)}`
                  : undefined,
              }));
              if (item.allowOther !== false)
                optionRows.push({
                  suffix: ` ${item.options.length + 1}. Type something else`,
                  description: undefined,
                });
              return (bodies[index] = { prompt: clean(item.prompt), optionRows });
            };
            const wrapCache = new Map<string, string[]>();
            const truncCache = new Map<string, string>();
            const headerCache = new Map<string, string>();
            let cachedWidth = -1;
            const submit = (cancelled: boolean, reason?: string) => {
              if (settled) return;
              settled = true;
              done({
                cancelled,
                answers: cancelled
                  ? []
                  : params.questions.flatMap((q) =>
                      answers.has(q.id) ? [answers.get(q.id)!] : [],
                    ),
                ...(reason ? { reason } : {}),
              });
            };
            cancel = () => submit(true, "Aborted or session ended");
            active.add(cancel);
            signal?.addEventListener("abort", cancel, { once: true });
            if (signal?.aborted) cancel();
            const editor = new Editor(tui, {
              borderColor: (s) => theme.fg("accent", s),
              selectList: {
                selectedPrefix: (s) => s,
                selectedText: (s) => s,
                description: (s) => s,
                scrollInfo: (s) => s,
                noMatch: (s) => s,
              },
            });
            const advance = () => {
              if (params.questions.length === 1) submit(false);
              else {
                tab++;
                selected = 0;
              }
              tui.requestRender();
            };
            editor.onSubmit = (value) => {
              const q = params.questions[tab];
              if (!q) return;
              if (!value.trim() || value.length > 16000) {
                editor.setText(value);
                tui.requestRender();
                return;
              }
              answers.set(q.id, {
                id: q.id,
                value,
                label: value,
                wasCustom: true,
              });
              cleanAnswers.set(q.id, clean(value));
              editing = false;
              editor.setText("");
              advance();
            };
            return {
              get focused() { return editor.focused; },
              set focused(value: boolean) { editor.focused = value; },
              invalidate() { editor.invalidate(); },
              handleInput(data: string) {
                if (settled) return;
                if (matchesKey(data, "ctrl+c")) {
                  submit(true);
                  return;
                }
                if (editing) {
                  if (matchesKey(data, "escape")) {
                    editing = false;
                    editor.setText("");
                  } else editor.handleInput(data);
                  tui.requestRender();
                  return;
                }
                if (matchesKey(data, "escape")) {
                  submit(true);
                  return;
                }
                if (
                  params.questions.length > 1 &&
                  (matchesKey(data, "tab") ||
                    matchesKey(data, "right") ||
                    matchesKey(data, "left") ||
                    matchesKey(data, "shift+tab"))
                ) {
                  const direction =
                    matchesKey(data, "left") || matchesKey(data, "shift+tab")
                      ? -1
                      : 1;
                  tab =
                    (tab + direction + params.questions.length + 1) %
                    (params.questions.length + 1);
                  selected = 0;
                } else {
                  const q = params.questions[tab];
                  if (!q) {
                    if (
                      matchesKey(data, "enter") &&
                      answers.size === params.questions.length
                    )
                      submit(false);
                  } else {
                    const count = bodyFor(tab).optionRows.length;
                    if (matchesKey(data, "up"))
                      selected = Math.max(0, selected - 1);
                    if (matchesKey(data, "down"))
                      selected = Math.min(count - 1, selected + 1);
                    if (matchesKey(data, "enter")) {
                      const option = q.options[selected];
                      if (option) {
                        answers.set(q.id, {
                          id: q.id,
                          value: option.value,
                          label: option.label,
                          wasCustom: false,
                        });
                        cleanAnswers.set(q.id, clean(option.label));
                        advance();
                      } else editing = true;
                    }
                  }
                }
                tui.requestRender();
              },
              render(width: number) {
                const w = Math.max(1, width - 2);
                const rows = tui.terminal?.rows ?? 24;
                // Leave room for Pi's dock/footer and avoid dominating fullscreen widgets.
                const height = Math.max(3, Math.min(18, rows - 5));
                const showHeader = height >= 4;
                // Add decoration one row at a time so resizing never shrinks the body budget.
                const decorationRows = Math.min(4, Math.max(0, height - 9));
                const budget = height - 1 - (showHeader ? 1 : 0) - decorationRows;
                if (cachedWidth !== width) {
                  cachedWidth = width;
                  wrapCache.clear();
                  truncCache.clear();
                  headerCache.clear();
                }
                // Wrapping and width-fitting dominate a render; both are pure in
                // (styled text, width), and callers only read the results.
                const wrap = (text: string) =>
                  memo(wrapCache, text, () => wrapTextWithAnsi(text, w));
                const fit = (line: string) =>
                  memo(truncCache, line, () => truncateToWidth(line, width));
                const q = params.questions[tab];
                const view = q ? bodyFor(tab) : undefined;
                let header: string;
                if (params.questions.length > 1) {
                  const tabs = params.questions.map((_, i) => {
                    const label = tabLabel(i);
                    return theme.fg(tab === i ? "accent" : "muted", tab === i ? `[ ${label} ]` : label);
                  });
                  tabs.push(theme.fg(q ? "muted" : "accent", q ? "Submit" : "[ Submit ]"));
                  header = tabs.join("   ");
                } else header = theme.fg("accent", "Question");
                if (
                  params.questions.length > 1 &&
                  memo(headerCache, header, () => truncateToWidth(header, w)) !== header
                ) {
                  const position = `${tab + 1}/${params.questions.length + 1}`;
                  const suffix = q ? " · Submit" : "";
                  const label = q ? tabLabel(tab) : "Submit";
                  const labelWidth = w - position.length - suffix.length - 5;
                  const activeLabel = truncateToWidth(label, Math.max(1, labelWidth), "…");
                  header = labelWidth < 2
                    ? theme.fg("accent", `${position} Submit`)
                    : `${position} ${theme.fg("accent", `[ ${activeLabel} ]`)}${suffix}`;
                }
                const promptPrefix = !showHeader && params.questions.length > 1
                  ? (q ? `${tab + 1}/${params.questions.length + 1} ${w >= 28 ? "Submit" : "S"} | ` : "[ Submit ] ") : "";
                const prompt = promptPrefix + (view ? view.prompt : "Review your answers");
                const editorRows = editing ? editor.render(Math.max(10, w)) : [];
                const wrappedPrompt = wrap(prompt);
                const content: string[] = [];
                let focusRow = 0;
                if (view && !editing) {
                  const optionRows = view.optionRows;
                  for (let i = 0; i < optionRows.length; i++) {
                    const option = optionRows[i];
                    if (selected === i) focusRow = content.length;
                    const color = selected === i ? "accent" : "text";
                    content.push(...wrap(
                      theme.fg(color, `${selected === i ? "❯" : " "}${option.suffix}`),
                    ));
                    if (option.description) content.push(...wrap(
                      theme.fg("muted", option.description),
                    ));
                    // Once the viewport is provably full below the selected row,
                    // further options cannot appear or shift the layout: the scroll
                    // start pins to focusRow and promptLimit saturates at budget/2.
                    if (i >= selected && content.length >= focusRow + budget) break;
                  }
                } else if (!view) {
                  for (let i = 0; i < params.questions.length; i++) content.push(...wrap(
                    `${labels[i]}: ${cleanAnswers.get(params.questions[i].id) ?? "(unanswered)"}`,
                  ));
                  content.push(theme.fg("accent", answers.size === params.questions.length
                    ? "Enter to submit all answers" : "Answer every question before submitting"));
                  focusRow = content.length - 1;
                }
                const promptLimit = Math.max(1, budget - Math.min(editing ? editorRows.length : Math.min(content.length, Math.ceil(budget / 2)), budget - 1));
                const promptRows = wrappedPrompt.slice(0, promptLimit);
                if (wrappedPrompt.length > promptRows.length) {
                  const indicator = w - promptPrefix.length >= 32 ? " … [prompt truncated]" : "…";
                  const last = promptRows.length - 1;
                  promptRows[last] = `${truncateToWidth(promptRows[last], Math.max(0, w - indicator.length), "")}${indicator}`;
                }
                // Keep the question and controls stationary while long options scroll.
                const available = Math.max(1, budget - promptRows.length);
                const start = Math.max(0, Math.min(focusRow, content.length - available));
                let body = content.slice(start, start + available);
                if (editing) {
                  const editorBody = editorRows.length > available ? editorRows.slice(1, -1) : editorRows;
                  // Pi renders the active cursor in reverse video. Keep its row
                  // visible even when the editor itself exceeds our body budget.
                  const cursorRow = Math.max(0, editorBody.findIndex((line) => line.includes("\x1b[7m")));
                  const editorStart = Math.max(0, Math.min(cursorRow, editorBody.length - available));
                  body = editorBody.slice(editorStart, editorStart + available);
                }
                const hint = editing
                  ? "Ctrl+C cancel · Esc back · Enter save"
                  : `Esc cancel · ↑↓ choose · Enter select${params.questions.length > 1 ? " · Tab next" : ""}`;
                const rule = decorationRows >= 1
                  ? theme.fg("borderMuted", "─".repeat(Math.max(0, width)))
                  : "";
                return [
                  ...(decorationRows >= 1 ? [rule] : []),
                  ...(showHeader ? [` ${header}`] : []),
                  ...(decorationRows >= 3 ? [""] : []),
                  ...promptRows.map((line) => ` ${line}`),
                  ...(decorationRows >= 4 ? [""] : []),
                  ...body.map((line) => ` ${line}`),
                  ` ${theme.fg("dim", hint)}`,
                  ...(decorationRows >= 2 ? [rule] : []),
                ].map(fit);
              },
            };
          },
          { overlay: false },
        );
        return finish(
          result ?? { cancelled: true, answers: [], reason: "UI closed" },
        );
      } catch (error) {
        return finish({
          cancelled: true,
          answers: [],
          reason: error instanceof Error ? error.message : "UI failed",
        });
      } finally {
        signal?.removeEventListener("abort", cancel);
        active.delete(cancel);
        inFlight = false;
        pi.events.emit("pi-interactive:questionnaire-waiting", {
          toolCallId,
          waiting: false,
        });
      }
    },
  });
}
