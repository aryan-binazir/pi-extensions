# ADR 010: Opt-in adaptive review with independent authorization provenance

Status: retired; the Sentinel extension and its delegation bridge have been
removed. This records the removed implementation, not current package guarantees.

One finding outlives the code: Pi's persisted user role is not evidence of human
origin, because it also contains expanded skills and templates, and extension
custom messages can become user-role model input. Anything that needs to
distinguish human authorization from agent-authored input must record the
original interactive/RPC message before expansion rather than trusting the role.
