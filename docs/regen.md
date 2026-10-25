# Regen

[Back to README](../README.md)

Regen gives Pi threads short, descriptive names. Enable its entrypoint with
`pi config`, then `/reload`. From a checkout, try
`pi -e ./extensions/regen/index.ts`.

## Naming

- A fresh, unnamed thread is named in the background after its first user message
  is sent, without waiting for the assistant or delaying its response.
- Existing names and resumed conversations are left alone.
- Run **`/regen-name`** to generate or replace the current thread's name using
  the active conversation branch. No name is changed when generation fails.

Titles aim for **3–6 words**, with a **60-character maximum**, enforced at a word
boundary where possible. Names are persisted using Pi's session naming API and
appear in the session selector and footer.

Requests contain bounded user/assistant text, not tool output, images, or the
main system prompt. They are tool-free and do not add conversation messages or
change the active model or its effort. A newer naming request supersedes an
older one. Leaving the session cancels pending work; naming never overwrites
a name changed while its request was running.

## Project-local configuration

By default Regen calls **`openai-codex/gpt-6-luna`** with **low** reasoning,
using Pi's existing provider authentication. The model must be registered and
authenticated, but **does not need to be in `/scoped-models`**.

Optionally create **`.pi/regen.json`** in Pi's working directory:

```json
{
  "model": "openai-codex/gpt-6-luna",
  "thinking": "low"
}
```

Both fields are optional. `model` is an exact `provider/model` ID; `thinking`
accepts `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Regen reads the file
on each request, so edits need no reload. Keep machine-specific configuration
untracked, like other local `.pi` settings.

Project-local configuration is read only after project trust is granted.
Untrusted projects use the defaults. Malformed settings, unavailable models,
and authentication/provider errors are reported without changing the current
name or silently choosing a different model. Requests time out after 30 seconds;
use `/regen-name` to retry if automatic naming fails.
