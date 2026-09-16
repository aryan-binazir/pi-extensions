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
