# 023: Shared real-Pi test sessions

Status: accepted.

## Context

Extension tests repeated resource-loader flags, credential stores, model runtime
creation, session binding and cleanup. Host API changes required editing several
fixtures, while fabricated extension APIs could keep passing after the real host
changed. ADR 000 assigns implementation and tests to each extension directory.

## Decision

`tests/pi-session.ts` owns headless session setup against the pinned Pi SDK.
`withPi(options, run)` gives the callback a live session, its extension runner,
scripted faux provider, session runtime and isolated workspace/config directories.
It awaits abort and extension shutdown, disposes the current session, restores
its environment changes and removes its temporary directory even when setup or
the callback throws. An externally supplied workspace remains the caller's
responsibility. Callers that change PATH or argv restore them themselves. Tests
run sequentially within each process. Nested fixtures temporarily replace the process-wide agent
directory, so outer sessions must not read it while an inner fixture is active.

Factories load in isolation. Settings can select package or path entrypoints.
The harness fixes loader exclusions, in-memory credentials and offline model
loading; tests cannot override them. Tests own behavior-specific settings, model
selection and typed UI bindings. Runtime replacement recreates services, reruns
configuration and rebinds the extensions. Configuration must tolerate repeated calls. The session
and runner handles follow the current runtime after new, resume and fork; one
faux provider and its remaining response script survive those replacements.

Factory cleanup starts when services have loaded, before test configuration or
session creation can fail. A real unbound Pi runner delivers shutdown to those
loaded extensions on setup failure. The fixture tracks session invalidation so a
failed replacement does not shut down the retired session twice. Errors retain
Pi diagnostics and stacks; combined failures keep every cause.

Each option supports multiple migrated tests: factories in todo and subagents;
settings in package and fast mode; responses in todo/scripted-tool and editor
snapshot tests; workspaces in footer and Neovim; session managers in effort and
fast mode; start events in startup and resume regressions; configuration in
effort and fast mode; bindings in footer, effort and Neovim. Add no single-test
options or extension-specific behavior to the harness.

## Consequences

This is test infrastructure, not an extension framework. Extension directories
still own their tests and production behavior. The module is outside the package
manifest's extension entrypoints and production code never imports it.

Real-host tests cover footer session statistics and workflow external-editor
settings. The workflow test verifies the getSettings path; footer entries move
the leaf and therefore do not distinguish the optional getEntryCount path. Background activity now runs through real Pi tools,
with synthetic child executables at the process boundary. Existing model-runtime
unit fixtures, malformed host states, legacy APIs without getSettings, and TUI
component/timing doubles remain local. UI doubles do not replace the host in the
real workflow settings test.

Concurrent migration candidates are Escape Continue, Vi mode, prompt stash,
editor lifecycle, BTW, and subagent tracker/profile tests and their test-support
module. Stock-child and delegated-child parent tests also retain their own setup
outside this change's ownership. The delegated-child JavaScript fixture is a
standalone child CLI, not an in-process test-session fixture.

Verification uses `npm run check`, before/after test counts and a setup grep.
A live TUI drive is not meaningful for this test-only refactor; no production
behavior changes.
