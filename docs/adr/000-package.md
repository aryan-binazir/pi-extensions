# Independent Pi package entrypoints

Status: accepted.

Pi package discovery can load every file in an extension directory. Helpers and
tests must not execute as extensions, and each feature must remain selectable.
The root manifest therefore lists each `extensions/<feature>/index.ts` file
explicitly; the manifest and `tests/package.test.ts` own the current count. Each
directory owns its implementation and tests. There is no shared extension
framework or implicit loader.

Development pins Pi's SDK, UI and provider libraries to 0.85.1 because the editor
adapter and session lifecycle depend on that API version. The manifest declares
Pi's bundled imports as wildcard peer dependencies, as required by Pi's package
contract. Git consumers get dependency installation through Pi's package manager.
Verification is local (`npm run check`); this repository runs no CI. Desktop
behavior still requires terminal verification.

Extensions communicate through named transient events only when a feature
needs to coordinate with another runtime or extension. Events never become
conversation messages or saved settings.
