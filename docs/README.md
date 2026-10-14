# docs/

Design documentation and decision records for Void. Read order for a fresh session:

1. [`user-guide.md`](user-guide.md) — the user-facing guide: install, models, tools, settings, troubleshooting, FAQ
2. [`security-posture.md`](security-posture.md) — the honest security audit: per-property enforcement, threat model, residual-risk register
3. [`adr/`](adr/) — decision records (why things are the way they are; immutable once accepted)
4. [`architecture.md`](architecture.md) — the system design (living document)
5. [`stream-json.md`](stream-json.md) — the frozen v1 stream-JSON event contract (`void schema` prints it)
6. [`mvp-scope.md`](mvp-scope.md) — current milestone scope, acceptance criteria, what's next
7. [`post-mvp-roadmap.md`](post-mvp-roadmap.md) — the post-MVP plan: phases, library choices, prior-art notes per workstream
8. [`contracts-gaps.md`](contracts-gaps.md) — contracts decisions log (resolved adjudications)

The versioned system prompt lives in [`../prompts/default.md`](../prompts/default.md). Runnable examples live in
[`../examples/`](../examples/).
