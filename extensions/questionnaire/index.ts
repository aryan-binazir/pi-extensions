import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  matchesKey,
  stripTerminalSequences,
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
              invalidate() {},
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
                const w = Math.max(1, width);
                const lines: string[] = [];
                let focusLine = 0;
                if (params.questions.length > 1)
                  lines.push(
                    params.questions
                      .map(
                        (q, i) =>
                          `${tab === i ? ">" : ""}${answers.has(q.id) ? "✓" : "○"} ${q.label || q.id}`,
                      )
                      .concat(
                        `${tab === params.questions.length ? ">" : ""} Submit`,
                      )
                      .join(" | "),
                  );
                const q = params.questions[tab];
                if (q) {
                  lines.push(q.prompt);
                  focusLine = lines.length + selected;
                  q.options.forEach((o, i) =>
                    lines.push(
                      `${selected === i ? ">" : " "} ${o.label}${o.description ? ` — ${o.description}` : ""}`,
                    ),
                  );
                  if (q.allowOther !== false)
                    lines.push(
                      `${selected === q.options.length ? ">" : " "} Type an answer`,
                    );
                } else {
                  for (const q of params.questions)
                    lines.push(
                      `${q.label || q.id}: ${answers.get(q.id)?.label ?? "(unanswered)"}`,
                    );
                  lines.push(
                    answers.size === params.questions.length
                      ? "Enter to submit all answers"
                      : "Answer every question before submitting",
                  );
                }
                const wrapped = lines.map((line) =>
                  wrapTextWithAnsi(stripTerminalSequences(line).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""), w),
                );
                const content = wrapped.flat();
                const focusRow = wrapped.slice(0, focusLine).reduce((n, rows) => n + rows.length, 0);
                const height = Math.max(1, (tui.terminal?.rows ?? 24) - 2);
                const footer = wrapTextWithAnsi(
                  editing
                    ? "Enter saves • Esc returns • Ctrl+C cancels questionnaire"
                    : "↑↓ select • Tab/←→ tabs • Enter confirm • Esc cancels",
                  w,
                ).slice(0, Math.max(1, Math.floor(height / 4)));
                const editorBudget = Math.max(0, height - footer.length - 1);
                const editorRows = editing && editorBudget > 0 ? editor.render(w).slice(-editorBudget) : [];
                const available = Math.max(0, height - footer.length - editorRows.length);
                const start = Math.max(0, Math.min(
                  focusRow - Math.floor(available / 2), content.length - available,
                ));
                return [...content.slice(start, start + available), ...editorRows, ...footer];
              },
            };
          },
          { overlay: true },
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
