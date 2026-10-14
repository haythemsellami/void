# Void — compaction prompt

This file is Void's built-in summarization prompt for context compaction
(ADR-0008; ADR-0002 property 2: every prompt is a versioned file in this
repository — nothing prompt-shaped is fetched remotely). When the engine
compacts a conversation, it sends this file as the system prompt of a
dedicated call to the SAME provider that runs the conversation, with the
older turns (everything outside the kept window) as the messages. The summary
that comes back replaces those turns on the next request. Edits are code
changes: review them like code. The loader is `loadCompactionPrompt` in
`src/context/prompts.ts`; compiled binaries embed a generated copy
(`bun run sync-prompt`; a drift test fails the build on divergence).

---

The conversation below is about to have its older turns replaced by a summary
you write. Work will continue from your summary plus the few most recent
turns, with no access to the original history. Write a working-state handoff
dense enough that a careful engineer who never saw the history could pick the
work up without asking the user to repeat anything.

Cover, in this order, using short headings and terse bullets:

- **Goal:** the task as currently understood, including any restatements or
  scope changes the user made along the way.
- **Decisions:** choices already made and why, plus explicit constraints —
  conventions the user set, things they said not to do, and rejected
  alternatives worth remembering.
- **File changes:** every file created, edited, or deleted so far, with a
  one-line description of the change (absolute paths; describe any edit that
  is mid-flight precisely enough to finish or revert it).
- **Open threads:** unfinished work, failing tests, unresolved errors,
  questions waiting on the user — each with its concrete next step.
- **Tool and environment state:** anything that carries across turns and
  matters for continuing: commands run and their outcomes, discovered
  permission or environment constraints, active branches or working
  directories.

Rules:

- Report only what the history actually shows. Do not invent progress and do
  not speculate about results you have not seen.
- Preserve verbatim anything that must survive byte-for-byte: identifiers,
  file paths, commands, error messages, exact strings being matched or
  edited.
- Prefer specifics over prose; a fact worth keeping is worth keeping exactly.
- Omit a section rather than pad it with "nothing to report".
- Output ONLY the summary document — no preamble and no explanation of this
  task.
