# ADR-0013: Task tool — scoped subagents with mode presets

- **Status:** Accepted (2026-10-14)
- **Deciders:** project owner, on agent recommendation

## Context

Roadmap workstream 6. Void's model-mixing answer is explicit and visible: mode
presets are versioned prompt files, the model is the user's choice, and nothing
routes opaquely.

## Decision

A `task` builtin tool: input `{description, prompt, mode?}`. Execution spawns a CHILD
`runConversation` — same provider, ISOLATED message list (system prompt = the mode
preset + the task description/prompt; NO parent history), tool registry subset
(read-only tools only at P1: read_file/glob/grep + the async status/kill pair — no
bash, no edit_file, no task recursion), no thread persistence (child results return
as the parent's tool result; the parent's JSONL records the task call and its
outcome, not a child thread).

- **Mode presets**: versioned prompt files `prompts/modes/<mode>.md` (ADR-0002
  property 2; embedded for compiled binaries via the extended sync-prompt). P1 ships
  `explorer` (read-only investigation, returns findings) and `planner` (produces a
  step plan). Fresh wording, clean-room.
- **Budgets**: child inherits maxToolRounds (default 10, lower than the parent's 25)
  and a token stopBudget; exceeded → structured error result naming the budget.
- **Permissions**: child calls run under `context: "subagent"` (the field exists in
  the rules); DEFAULT_RULES' write/ask classifications apply unchanged — since the
  P1 tool subset is read-only + async-status, everything is allow-classified anyway;
  the context marker is the seam for stricter future policies.
- **Concurrency**: P1 sequential (one task at a time in the parent's turn loop);
  parallel children + coordination tools are P2 with the remote-runner ADR.
- **Stream contract**: the child's events are NOT streamed individually; the parent
  emits one tool_call/tool_result pair (the frozen contract unchanged). A P2 additive
  `task_progress` event may follow with its own ADR if experience demands it.

## Consequences

Model mixing arrives as explicit configuration (mode presets + `--model`), not server
routing. Costs: child isolation means no incremental visibility in P1 (mitigated by
small default budgets and the description-first contract); no persistence means a
crashed parent loses child detail (acceptable — the parent's own transcript carries
the summary). `create_thread`-style persistent children are deliberately NOT in P1.
