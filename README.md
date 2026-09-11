# pi-extension

Personal extensions and setup for the Pi coding editor.

## Local setup

Pi is installed through mise. The launcher at `~/.local/bin/pi` resolves the
installed executable with `mise which pi` to avoid calling itself through PATH.
A copy is kept in `bin/pi`.

The global settings in `~/.pi/agent/settings.json` use provider `openai-codex`,
model `gpt-6-astra`, and `defaultThinkingLevel` set to `low`.
Credentials stay outside this repository.

The Bash alias in `~/.bashrc` updates Pi and installed extensions, then starts Pi
only if the update succeeds:

```bash
alias pie='pi update --all && pi'
```

Run `source ~/.bashrc` in an existing terminal to load it.

No extensions have been added yet.
