List currently available model selectors (`provider/id`) and resolved model roles for this session.

Use before setting `task.model` so you pass an exact selector from the live catalog — the same id can exist on multiple providers (e.g. `cursor/gpt-5.6-sol` vs `openai-codex/gpt-5.6-sol`).

# When to use
- Pick a concrete model for a `task` spawn (`task.model`).
- Discover which providers expose a given id.

# Do not
- Do **not** launch a subagent through eval `agent()` just to pick a model. For one (or a batch of) subagents, use the native `task` tool with `model` set from this list. Reserve eval `agent()` for code-orchestrated waves (parallel verify loops, schema-driven pipelines, budget gates).

# Inputs
- `query`: Optional substring filter over provider, id, `provider/id`, or display name.
- `provider`: Optional exact provider filter (case-insensitive).
- `limit`: Max model rows to return (default 100). Raise when truncated.
- `refresh`: When true, refresh the model catalog before listing.

# Output
- Compact `provider/id` lines (optionally with a display name).
- A short Roles block mapping `@role` → resolved selector when configured.
- Footer with match counts / truncation hints.
