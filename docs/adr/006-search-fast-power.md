# Search, fast models and work-scoped power inhibition

## Status

The DuckDuckGo web-search extension was removed after repeated live searches returned HTTP 202. The search design and verification below are historical; fast mode and auto-caffeinate remain active.

## Decision

Each extension owns its Pi adapter and one implementation module. No shared integration framework is introduced.

`web_search` accepts a nonempty query of at most 1000 characters and an optional integer limit of 1–10. It contacts only `https://html.duckduckgo.com/html/`. HTTPS retains hostname verification while a per-request DNS lookup rejects nonpublic addresses. Redirects are errors. The complete request has a ten-second deadline and the response has a one-million-byte cap. htmlparser2 decodes entities and finds result titles, snippets and redirect-wrapper destinations. Links are returned, never fetched. Output is explicitly untrusted. Challenges, rate limits, changed markup and network failures are errors; recognized no-results markup returns an empty list. DuckDuckGo HTML is an upstream webpage, not a guaranteed search API.

`/fast [on|off]` switches between base and `~fast` model entries. Aliases exist only for the `openai` Responses path on api.openai.com and `openai-codex` Responses path on chatgpt.com. Installation skips providers with another extension's legacy registration to preserve its endpoint and authentication. A same-ID Provider wrapper wraps the registered native provider or the runtime builtin before models.json composition, so removing or updating base-model overrides takes effect on refresh. Eligibility and config-declared direct models are snapshotted from the configured provider view at installation. Builtin aliases use native metadata; no base-model overrides carry over to builtin aliases. Config-declared aliases retain their installation snapshot until restart. Pi 0.85.1 requires guarded access to the private `runtime.builtins` map to retain the pi.dev catalog overlay, with public `builtinProviders()` factories as the fallback when unavailable. The wrapper preserves authentication and model filtering, strips the alias before requests and passes `serviceTier: "priority"` into the original provider stream. Pi 0.85.1 streamSimple drops provider-specific options, so the wrapper uses Pi's exported base-option and reasoning helpers before dispatching to stream. The original provider computes usage costs, including its priority multiplier; alias metadata retains base rates to avoid charging the multiplier twice. Costs remain upstream estimates, not proof of entitlement or a billing receipt. No provider credentials are inspected or changed. Reloads avoid duplicate wrappers. Resumed saved aliases are restored after session_start registration; Pi may first display its fallback-model warning because aliases are unavailable before that lifecycle event. Disabling this extension leaves saved aliases unavailable.

Auto-caffeinate starts no resources during extension loading. Agent start acquires inhibition only when the OS positively reports AC power. Agent settled starts a five-second linger, and background task IDs hold the inhibitor independently. The event contract is `pi-interactive:background-activity` with `{id: string, active: boolean}` on Pi's session event bus. The subagents integration emits these transitions; duplicate IDs are idempotent. Shutdown unsubscribes and reaps the child. Power checks cache for one second; a two-second watchdog refreshes power state and recovers failed helpers. An empty Linux power-supply directory is treated as a fixed-power desktop on AC. Battery, unknown state, a missing power-supply directory and unsupported platforms never acquire an inhibitor.

Linux runs `systemd-inhibit --what=idle --mode=block --no-ask-password` with a pipe-reading `/bin/cat` child. Closing the owner pipe releases it, including when the parent dies. macOS runs `/usr/bin/caffeinate -i -w PID`; `/usr/bin/pmset -g batt` detects power. Inhibitor failures are a no-op. These commands do not change persistent sleep settings. Linux desktop power reporting was empty on the inspected host and the restricted worker sandbox blocked system-bus access. An approved read-only host inhibitor listing succeeded; no host inhibitor was acquired, so actual host inhibition is not claimed. macOS process arguments and fixtures are not an actual Mac desktop smoke test.

## Verification

Tests exercise real built-in OpenAI serialization against an injected fetch response, all supported reasoning levels, request authentication, priority usage pricing, toggle/resume behavior and provider isolation. Search tests use deterministic HTML and request-boundary fixtures for parsing, deduplication, entities, DNS restrictions, status, redirects, deadlines and size limits. Power tests exercise AC/battery/unknown state, linger, background tasks, cache/watchdog and real `/bin/cat` pipe cleanup without inhibiting the user's desktop.

## Sources

- Installed Pi 0.85.1 `docs/extensions.md`, `docs/custom-provider.md`, `pi-ai/dist/api/openai-responses.js`, `openai-codex-responses.js` and `simple-options.js`.
- [OpenAI fast mode](https://developers.openai.com/api/docs/guides/fast-mode), checked 2026-09-11. Priority remains a supported request spelling; availability depends on model and account.
- [DuckDuckGo non-JavaScript search](https://duckduckgo.com/duckduckgo-help-pages/features/non-javascript).
- [Linux power-supply ABI](https://www.kernel.org/doc/Documentation/ABI/testing/sysfs-class-power).
- [systemd-inhibit](https://www.freedesktop.org/software/systemd/man/latest/systemd-inhibit.html).
- [Apple caffeinate source](https://github.com/apple-oss-distributions/PowerManagement/blob/main/caffeinate/caffeinate.c).
