# permissions — layered settings example

Two files, one merge. Copy them to their homes and the effective rule list
becomes the concatenation below (ADR-0006):

| File | Goes to |
|---|---|
| `user-settings.json` | `~/.config/void/settings.json` (user layer — you, everywhere) |
| `workspace-settings.json` | `<repo>/.void/settings.json` (workspace layer — this project) |

## The merge, worked

Rules are evaluated **first-match-wins**, and the merge order is
**workspace → user → built-in defaults** — so a workspace rule can shadow a
user rule, and both shadow the defaults. Scalar settings (not rules) use
the opposite direction you might guess: workspace also wins
(`defaultModel` below resolves to `anthropic/claude-haiku-4-5`).

Effective `permissions` array in this repo, in evaluation order:

1. *(workspace)* `bun run deploy…` → **ask** — shadows the user's `bun run …` allow below it
2. *(workspace)* `npm install|ci` → allow
3. *(workspace)* `edit_file` on `generated/**` → reject
4. *(user)* `bun run …` → allow
5. *(user)* `sudo …` → reject
6. *(user)* `git log|show|diff` → allow
7. *(defaults)* catastrophes reject, git commit/push ask, read-only allows, …
   (`src/permissions/defaults.ts`)

Worked outcomes with both layers active:

| Input | Matched rule | Decision |
|---|---|---|
| `bun run test` | user rule 4 | allow |
| `bun run deploy prod` | **workspace** rule 1 | ask (the user allow never fires — shadowed) |
| `sudo rm -rf /tmp/x` | user rule 5 | reject |
| `npm install` | workspace rule 2 | allow (the default ask is shadowed) |

Verify any of these without running anything:

```sh
void permissions test bash '{"command":"bun run deploy prod"}'   # exit 1 = ask
void permissions test bash '{"command":"sudo id"}'               # exit 2 = reject
void settings effective                                          # merged view + provenance
```

In headless runs `ask` denies the call with remediation text and the run
exits 1 (ADR-0003) — that is why explicit allow/reject rules matter for
automation.
