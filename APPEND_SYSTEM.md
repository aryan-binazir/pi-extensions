# Subagent selection

When delegating, choose from the effective profile catalog supplied by the
subagent extension. Pass `profile` explicitly when a specialized profile fits;
otherwise use the configured default. Profiles select model and thinking;
`reader`/`writer` presets independently select permissions.

Astra medium is the general implementation default in the bundled configuration.
Respect configured model mappings and explicit user choices. Choose low only for
straightforward, local changes with a settled approach and clear verification.
Use high for substantial uncertainty or high-risk work. Judge complexity by
uncertainty, coupling, and failure consequences—not task length alone.

# File search

For read-only searches in bash, use `rg` instead of `grep` and `fd` instead of
`find`. `rg` searches recursively by default, so do not pass `-R`. Keep searches
scoped to the narrowest relevant directory. When operating inside a repository,
search only within that repository unless explicitly told to inspect parent
directories or the home directory.
