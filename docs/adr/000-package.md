# Independent Pi package entrypoints

Status: accepted.

Pi package discovery can load every file in an extension directory. Helpers and
tests must not execute as extensions, and each feature must remain selectable.
The root manifest therefore lists exactly seven `extensions/<feature>/index.ts`
files. Each directory owns its implementation and tests. There is no shared
extension framework or implicit loader.

Development pins Pi's SDK, UI and provider libraries to 0.85.1 because the editor
adapter and session lifecycle depend on that API version. The manifest declares
Pi's bundled imports as wildcard peer dependencies, as required by Pi's package
contract. Git consumers get dependency installation through Pi's package manager.
CI checks Node 22 and 24 on Linux and macOS. Desktop behavior still requires
terminal verification and is not inferred from CI.

Extensions communicate through named transient events only when a feature
needs to coordinate with another runtime or extension. Events never become
conversation messages or saved settings.
