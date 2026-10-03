import type { EventEmitter } from "node:events";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const HANDOFF = "pi-interactive:effort-handoff";
type HandoffResult =
  | { kind: "cancelled" }
  | { kind: "completed"; notify: () => void };
interface Handoff {
  provider: string;
  model: string;
  level: ModelThinkingLevel;
  sessionFile: string | undefined;
  acknowledge: () => void;
  complete: (result: HandoffResult) => void;
}

export default function effort(pi: ExtensionAPI) {
  let current: ExtensionContext | undefined;
  const pending = new Set<() => void>();
  // Pi's own event facade is session-bound and becomes stale on replacement.
  // Node's process event emitter survives extension module reloads.
  const events: EventEmitter = process;
  const receiveHandoff = (request: Handoff) => {
    if (
      !current ||
      current.sessionManager.getSessionFile() !== request.sessionFile
    )
      return;
    const ctx = current;
    const cancel = () => {
      if (pending.delete(cancel)) request.complete({ kind: "cancelled" });
    };
    pending.add(cancel);
    request.acknowledge();
    const complete = (error?: string) => {
      if (!pending.delete(cancel)) return;
      request.complete({
        kind: "completed",
        notify: () => {
          if (current !== ctx) return;
          ctx.ui.notify(
            error ?? `Temporary ${request.provider}/${request.model} · ${request.level}`,
            error ? "error" : "info",
          );
        },
      });
    };
    void (async () => {
      const model = ctx.modelRegistry.find(request.provider, request.model);
      if (!model) throw new Error("Handoff model unavailable");
      if (!getSupportedThinkingLevels(model).includes(request.level))
        throw new Error("Handoff thinking level unsupported");
      const selected = await pi.setModel(model);
      if (current !== ctx) return;
      if (!selected)
        throw new Error("Handoff model authentication unavailable");
      pi.setThinkingLevel(request.level);
    })().then(
      () => complete(),
      (error) =>
        complete(
          error instanceof Error ? error.message : "Handoff failed",
        ),
    );
  };
  events.on(HANDOFF, receiveHandoff);
  let closeSlider: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    current = ctx;
  });
  pi.on("session_shutdown", () => {
    current = undefined;
    for (const cancel of pending) cancel();
    closeSlider?.();
    events.off(HANDOFF, receiveHandoff);
  });
  pi.registerCommand("effort", {
    description:
      "Thinking slider; /effort LEVEL; /effort new [LEVEL] [provider/model] starts a session with temporary model/effort",
    async handler(args, ctx) {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Effort requires an interactive terminal", "error");
        return;
      }
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const newSession = parts[0] === "new";
      if (newSession) parts.shift();
      let requested = parts.shift();
      let modelName = parts.shift();
      if (newSession && requested?.includes("/") && modelName === undefined) {
        modelName = requested;
        requested = undefined;
      }
      if (parts.length || (!newSession && modelName)) {
        ctx.ui.notify(
          "Usage: /effort [LEVEL] or /effort new [LEVEL] [provider/model]",
          "error",
        );
        return;
      }
      let model = ctx.model;
      if (modelName) {
        const slash = modelName.indexOf("/");
        model =
          slash > 0
            ? ctx.modelRegistry.find(
                modelName.slice(0, slash),
                modelName.slice(slash + 1),
              )
            : undefined;
      }
      if (!model) {
        ctx.ui.notify("Model unavailable", "error");
        return;
      }
      const levels = getSupportedThinkingLevels(model);
      let level = requested as ModelThinkingLevel | undefined;
      if (level && !levels.includes(level)) {
        ctx.ui.notify(`Supported levels: ${levels.join(", ")}`, "error");
        return;
      }
      if (!level) {
        try {
          level = await ctx.ui.custom<ModelThinkingLevel | undefined>(
            (tui, _theme, _keys, done) => {
              let selected = levels.indexOf(
                clampThinkingLevel(model, pi.getThinkingLevel()),
              );
              closeSlider = () => done(undefined);
              let frameWidth = -1;
              let frameModel = "";
              let top = "";
              let bottom = "";
              let head: string[] = [];
              let tail: string[] = [];
              let rows: (string[] | undefined)[] = [];
              const layout = (width: number, inner: number, text: string) =>
                wrapTextWithAnsi(stripTerminalSequences(text), inner).map(
                  (line) =>
                    width < 5
                      ? truncateToWidth(line, width, "")
                      : `│ ${truncateToWidth(line, inner, "", true)} │`,
                );
              return {
                invalidate() {},
                handleInput(data: string) {
                  if (
                    matchesKey(data, "escape") ||
                    matchesKey(data, "ctrl+c")
                  ) {
                    done(undefined);
                    return;
                  }
                  if (matchesKey(data, "enter")) {
                    done(levels[selected]);
                    return;
                  }
                  if (
                    data === "h" ||
                    matchesKey(data, "left") ||
                    matchesKey(data, "down")
                  )
                    selected = Math.max(0, selected - 1);
                  else if (
                    data === "l" ||
                    matchesKey(data, "right") ||
                    matchesKey(data, "up")
                  )
                    selected = Math.min(levels.length - 1, selected + 1);
                  tui.requestRender();
                },
                render(width: number) {
                  const innerWidth = Math.max(1, width - 4);
                  if (width !== frameWidth || model.id !== frameModel) {
                    frameWidth = width;
                    frameModel = model.id;
                    const blank = layout(width, innerWidth, "");
                    head = [
                      ...layout(width, innerWidth, `Effort — ${model.id}`),
                      ...blank,
                    ];
                    tail = [
                      ...blank,
                      ...layout(
                        width,
                        innerWidth,
                        "←→ adjust • Enter applies • Esc cancels",
                      ),
                    ];
                    rows = [];
                    if (width >= 5) {
                      top = `╭${"─".repeat(width - 2)}╮`;
                      bottom = `╰${"─".repeat(width - 2)}╯`;
                    }
                  }
                  const row = (rows[selected] ??= layout(
                    width,
                    innerWidth,
                    levels
                      .map((value, i) =>
                        i === selected ? `[● ${value}]` : `○ ${value}`,
                      )
                      .join(" ─ "),
                  ));
                  if (width < 5) return [...head, ...row, ...tail];
                  return [top, ...head, ...row, ...tail, bottom];
                },
              };
            },
            { overlay: true, overlayOptions: { width: 80 } },
          );
        } finally {
          closeSlider = undefined;
        }
      }
      if (!level) return;
      if (!newSession) {
        pi.setThinkingLevel(level);
        return;
      }
      // Capture only plain values and the process event bus; old session-bound pi
      // is invalid inside withSession after Pi reloads the extension runtime.
      const provider = model.provider;
      const modelId = model.id;
      const selectedLevel = level;
      const result = await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        async withSession(replacement) {
          const result = await new Promise<HandoffResult>((resolve) => {
            const receiptDeadline = setTimeout(
              () =>
                resolve({
                  kind: "completed",
                  notify: () => replacement.ui.notify(
                    "Effort extension did not acknowledge the new session",
                    "error",
                  ),
                }),
              5000,
            );
            events.emit(HANDOFF, {
              provider,
              model: modelId,
              level: selectedLevel,
              sessionFile: replacement.sessionManager.getSessionFile(),
              acknowledge: () => clearTimeout(receiptDeadline),
              complete: (result) => {
                clearTimeout(receiptDeadline);
                resolve(result);
              },
            } satisfies Handoff);
          });
          if (result.kind === "completed") result.notify();
        },
      });
      if (result.cancelled) ctx.ui.notify("New session cancelled", "info");
    },
  });
}
