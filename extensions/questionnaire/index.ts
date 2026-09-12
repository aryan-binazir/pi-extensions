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

/** Independent questionnaire; waiting notifications are paired by toolCallId. */
export default function questionnaire(pi: ExtensionAPI) {
  // Only trusted local code declares its own bounded storage/UI effects.
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
                    const count =
                      q.options.length + (q.allowOther === false ? 0 : 1);
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
                const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
                const q = params.questions[tab];
                const tabs = params.questions.map((item, i) => {
                  const label = `${answers.has(item.id) ? "✓ " : ""}${clean(item.label || item.id)}`;
                  return theme.fg(tab === i ? "accent" : "muted", tab === i ? `[ ${label} ]` : label);
                });
                tabs.push(theme.fg(q ? "muted" : "accent", q ? "Submit" : "[ Submit ]"));
                let header = params.questions.length > 1
                  ? tabs.join("   ")
                  : theme.fg("accent", "Question");
                if (params.questions.length > 1 && truncateToWidth(header, w) !== header) {
                  const position = `${tab + 1}/${params.questions.length + 1}`;
                  const suffix = q ? " · Submit" : "";
                  const label = q ? `${answers.has(q.id) ? "✓ " : ""}${clean(q.label || q.id)}` : "Submit";
                  const labelWidth = w - position.length - suffix.length - 5;
                  const activeLabel = truncateToWidth(label, Math.max(1, labelWidth), "…");
                  header = labelWidth < 2
                    ? theme.fg("accent", `${position} Submit`)
                    : `${position} ${theme.fg("accent", `[ ${activeLabel} ]`)}${suffix}`;
                }
                const promptPrefix = !showHeader && params.questions.length > 1
                  ? (q ? `${tab + 1}/${params.questions.length + 1} ${w >= 28 ? "Submit" : "S"} | ` : "[ Submit ] ") : "";
                const prompt = promptPrefix + (q ? clean(q.prompt) : "Review your answers");
                const editorRows = editing ? editor.render(Math.max(10, w)) : [];
                const wrappedPrompt = wrapTextWithAnsi(prompt, w);
                const content: string[] = [];
                let focusRow = 0;
                if (q && !editing) {
                  const options = [...q.options];
                  if (q.allowOther !== false) options.push({ value: "", label: "Type something else" });
                  options.forEach((option, i) => {
                    if (selected === i) focusRow = content.length;
                    const color = selected === i ? "accent" : "text";
                    content.push(...wrapTextWithAnsi(
                      theme.fg(color, `${selected === i ? "❯" : " "} ${i + 1}. ${clean(option.label)}`), w,
                    ));
                    if (option.description) content.push(...wrapTextWithAnsi(
                      theme.fg("muted", `     ${clean(option.description)}`), w,
                    ));
                  });
                } else if (!q) {
                  for (const item of params.questions) content.push(...wrapTextWithAnsi(
                    `${clean(item.label || item.id)}: ${clean(answers.get(item.id)?.label ?? "(unanswered)")}`, w,
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
                const rule = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
                return [
                  ...(decorationRows >= 1 ? [rule] : []),
                  ...(showHeader ? [` ${header}`] : []),
                  ...(decorationRows >= 3 ? [""] : []),
                  ...promptRows.map((line) => ` ${line}`),
                  ...(decorationRows >= 4 ? [""] : []),
                  ...body.map((line) => ` ${line}`),
                  ` ${theme.fg("dim", hint)}`,
                  ...(decorationRows >= 2 ? [rule] : []),
                ].map((line) => truncateToWidth(line, width));
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
