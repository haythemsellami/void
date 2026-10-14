# Void stream-JSON contract (v1.1 — v1 frozen with M4; one additive event)

Status: frozen at v1; **v1.1 (ADR-0008) adds exactly one event type,
`compaction`, additively** — every v1 event's shape is byte-identical. This
is Void's machine interface (ADR-0003): `void run` and `void resume` emit
**one JSON object per line on stdout**; logs and human summaries go to
stderr, never stdout. The event shapes are deliberately Claude-Code-shaped
(system/assistant/user/result envelopes with Anthropic-style message content
blocks) so existing `--stream-json` tooling parses Void output with minimal
changes.

Rules of the contract:

1. The **first** line of every session is a `system`/`init` event.
2. The **last** line of every session is a `result` event.
3. Lines are strict JSON with no embedded newlines; consumers may read
   line-delimited (`readline`) or stream-parse.
4. Additive fields **may** appear in future versions; the fields documented
   here and their meanings never change. The machine-readable mirror of this
   document is exported from `src/app/stream-json.ts` (`STREAM_JSON_SCHEMA`)
   and printable via `void schema`.
5. Timestamps inside events are epoch milliseconds (`duration_ms`); thread
   identity is the opaque `thread_id` (charset `[A-Za-z0-9_-]+`).

## Event types

### 1. `system` / `init` — session opens

```json
{
  "type": "system",
  "subtype": "init",
  "thread_id": "9f1c2a4e-…",
  "model": "anthropic/claude-sonnet-4-5",
  "workspace_root": "/abs/path/to/workspace",
  "tools": ["bash", "edit_file", "glob", "grep", "read_file"],
  "resumed_from": null,
  "version": "0.0.0"
}
```

| Field | Meaning |
|---|---|
| `thread_id` | The thread this session writes (new or resumed). |
| `model` | The resolved ModelRef (`<provider>/<model-id>`). |
| `workspace_root` | Absolute workspace root tools operate on. |
| `tools` | Tool names the model may call, sorted. |
| `resumed_from` | The continued thread's id when resuming, else `null`. |
| `version` | Void CLI version. |

### 2. `assistant` — model output (text and tool calls)

Emitted with a single `text` block per batch of consecutive text deltas
(one event per provider round's text), and one `tool_use` block per tool
call when the call starts:

```json
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Reading the file…"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"read_file","input":{"path":"/abs/f.txt"}}]}}
```

`input` is the exact parsed tool input object. Tool-call results are NOT in
assistant events — they arrive as `user` events below.

### 3. `user` — tool results

One event per finished tool call; `content` is the one-line result summary
(explicitly derived, deterministic — the same text the engine's progress
events carry); `is_error` is true iff the result was an error result:

```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"     1\thello void…","is_error":false}]}}
```

### 4. `permission` — every permission decision

One event per evaluated tool call (allow decisions included — the stream is
the audit trail; consumers filter). In headless mode `ask`/`delegate`
decisions deny the call (`headless_denied: true`) per ADR-0003:

```json
{
  "type": "permission",
  "decision": "ask",
  "headless_denied": true,
  "tool": "bash",
  "input": { "command": "git push origin main" },
  "reason": "rule[1] (tool \"bash\") matched input key \"command\" → ask",
  "message": "git commit/push changes shared history — … — Void is running headless and cannot ask interactively (ADR-0003), so the call was denied. …"
}
```

| Field | Meaning |
|---|---|
| `decision` | The rule engine's action: `allow` · `reject` · `ask` · `delegate`. |
| `headless_denied` | True when the call did NOT run (all but `allow` headless). |
| `reason` | Audit line naming the matched rule (or default policy). |
| `message` | The effective denial text the model saw; `null` when none. |

### 5. `compaction` — the context prefix was replaced by a summary (v1.1)

Emitted once per executed compaction (ADR-0008), between the rounds that
existed when it ran and the first post-compaction round. The conversation
continues from a summary message plus the `kept_turns` newest turns; the
summarized turns remain in the thread log (compaction is a view, not a
rewrite). Consumers may ignore this event without breaking v1 parsing.

```json
{"type":"compaction","summarized_turns":12,"kept_turns":2,"trigger":"threshold"}
{"type":"compaction","summarized_turns":3,"kept_turns":2,"trigger":"manual","assumed_context_window":true}
```

| Field | Meaning |
|---|---|
| `summarized_turns` | Provider turns replaced by the summary. |
| `kept_turns` | Newest turns kept verbatim after the summary. |
| `trigger` | `threshold` (estimated context crossed the configured percent of the model's window) or `manual` (`void resume --compact`). |
| `assumed_context_window` | Present (`true`) only when the threshold was computed against the 200_000 fallback window because the model registry does not know the resolved model's real window (ollama/openai passthrough refs). |

### 6. `result` — session closes

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "exit_code": 0,
  "thread_id": "9f1c2a4e-…",
  "duration_ms": 1840,
  "num_turns": 3,
  "stop_reason": "end_turn",
  "total_usage": { "input_tokens": 4310, "output_tokens": 212 },
  "result": "Edited notes.txt and verified the test run."
}
```

| Field | Meaning |
|---|---|
| `subtype` | See the mapping table below. |
| `is_error` | `exit_code !== 0`. |
| `exit_code` | The process exit code (see matrix). |
| `num_turns` | Provider rounds made. |
| `stop_reason` | Engine stop reason: a provider `StopReason` or `provider_error` / `max_tool_rounds` / `budget_exceeded`. Local guard stops are `subtype: "success"` — the reason rides this field. |
| `total_usage` | Sums across rounds; cache fields appear only when nonzero. |
| `result` | Final assistant text (success only). |
| `error` | Error message (non-success only). |

## Exit-code matrix (process exit AND `result.exit_code`)

| Exit | `result.subtype` | Meaning |
|---|---|---|
| 0 | `success` | Task completed (incl. local guard stops like `max_tool_rounds`). |
| 1 | `error_ask_required` | A permission rule said `ask` (or `delegate`) — denied headless with remediation. |
| 2 | `error_permission_rejected` | A permission rule rejected a call. |
| 3 | `error_provider` | Provider/stream failure (`stop_reason: "provider_error"`). |
| 3 | `error_run` | Run-level failure (e.g. unknown thread on resume). |
| 64 | — (usage error, no `result` semantics guaranteed) | Malformed CLI usage; stderr explains. |

Precedence when several apply: **2 (rejected) > 1 (ask) > 3 (provider/run) > 0**.

`void permissions test` does not run a session; it uses its own stable codes:
0 = allow, 1 = ask, 2 = reject (64 for malformed input).

## Complete example session

```
$ void run "add a README section about the build" --text
{"type":"system","subtype":"init","thread_id":"t8f3…","model":"anthropic/claude-sonnet-4-5","workspace_root":"/work/app","tools":["bash","edit_file","glob","grep","read_file"],"resumed_from":null,"version":"0.0.0"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Checking the current README first."}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"read_file","input":{"path":"/work/app/README.md"}}]}}
{"type":"permission","decision":"allow","headless_denied":false,"tool":"read_file","input":{"path":"/work/app/README.md"},"reason":"rule[4] (tool \"read_file\") matched input key \"*\" → allow","message":null}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"     1\t# App…","is_error":false}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_02","name":"edit_file","input":{"path":"/work/app/README.md","old_str":"## Install","new_str":"## Build\n\nbun run build\n\n## Install"}}]}}
{"type":"permission","decision":"allow","headless_denied":false,"tool":"edit_file","input":{…},"reason":"rule[8] (tool \"edit_file\", context \"**\") matched input key \"*\" → allow","message":null}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_02","content":"--- README.md\n+++ README.md\n…","is_error":false}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Added a Build section above Install."}]}}
{"type":"result","subtype":"success","is_error":false,"exit_code":0,"thread_id":"t8f3…","duration_ms":4210,"num_turns":3,"stop_reason":"end_turn","total_usage":{"input_tokens":5104,"output_tokens":298},"result":"Added a Build section above Install."}
```

## Consumer example

A minimal driver that prints tool activity and the final summary:

```bash
void run "run the tests and fix what fails" --workspace . |
  node -e '
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const e = JSON.parse(line);
      if (e.type === "assistant") {
        for (const b of e.message.content) {
          if (b.type === "tool_use") console.log("tool:", b.name, JSON.stringify(b.input));
          if (b.type === "text") console.log("say:", b.text);
        }
      }
      if (e.type === "permission" && e.headless_denied) console.log("DENIED:", e.tool, "—", e.decision);
      if (e.type === "result") console.log("done:", e.subtype, "exit", e.exit_code);
    });
  '
```

## JSON Schema

The same schema is available machine-readable via `void schema` (exported as
`STREAM_JSON_SCHEMA` from `src/app/stream-json.ts`). It validates a session
as an array of lines — each line matches exactly one `oneOf` branch:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Void stream-JSON contract (v1.1; v1 frozen, one additive event)",
  "description": "One JSON object per line on stdout. First line: system/init. Last line: result. v1.1 (ADR-0008) adds the compaction event; every v1 event shape is unchanged. Additive fields may appear; documented fields never change. See docs/stream-json.md.",
  "type": "array",
  "items": {
    "oneOf": [
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "system"
          },
          "subtype": {
            "const": "init"
          },
          "thread_id": {
            "type": "string"
          },
          "model": {
            "type": "string"
          },
          "workspace_root": {
            "type": "string"
          },
          "tools": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "resumed_from": {
            "type": [
              "string",
              "null"
            ]
          },
          "version": {
            "type": "string"
          }
        },
        "required": [
          "type",
          "subtype",
          "thread_id",
          "model",
          "workspace_root",
          "tools",
          "resumed_from",
          "version"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "assistant"
          },
          "message": {
            "type": "object",
            "properties": {
              "role": {
                "const": "assistant"
              },
              "content": {
                "type": "array",
                "items": {
                  "oneOf": [
                    {
                      "type": "object",
                      "properties": {
                        "type": {
                          "const": "text"
                        },
                        "text": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "type",
                        "text"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "type": {
                          "const": "tool_use"
                        },
                        "id": {
                          "type": "string"
                        },
                        "name": {
                          "type": "string"
                        },
                        "input": {
                          "type": "object"
                        }
                      },
                      "required": [
                        "type",
                        "id",
                        "name",
                        "input"
                      ],
                      "additionalProperties": false
                    }
                  ]
                }
              }
            },
            "required": [
              "role",
              "content"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "type",
          "message"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "user"
          },
          "message": {
            "type": "object",
            "properties": {
              "role": {
                "const": "user"
              },
              "content": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "const": "tool_result"
                    },
                    "tool_use_id": {
                      "type": "string"
                    },
                    "content": {
                      "type": "string"
                    },
                    "is_error": {
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "type",
                    "tool_use_id",
                    "content",
                    "is_error"
                  ],
                  "additionalProperties": false
                }
              }
            },
            "required": [
              "role",
              "content"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "type",
          "message"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "permission"
          },
          "decision": {
            "enum": [
              "allow",
              "reject",
              "ask",
              "delegate"
            ]
          },
          "headless_denied": {
            "type": "boolean"
          },
          "tool": {
            "type": "string"
          },
          "input": {
            "type": "object"
          },
          "reason": {
            "type": "string"
          },
          "message": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "type",
          "decision",
          "headless_denied",
          "tool",
          "input",
          "reason",
          "message"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "compaction"
          },
          "summarized_turns": {
            "type": "integer",
            "minimum": 0
          },
          "kept_turns": {
            "type": "integer",
            "minimum": 0
          },
          "trigger": {
            "enum": [
              "threshold",
              "manual"
            ]
          },
          "assumed_context_window": {
            "type": "boolean"
          }
        },
        "required": [
          "type",
          "summarized_turns",
          "kept_turns",
          "trigger"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "result"
          },
          "subtype": {
            "enum": [
              "success",
              "error_ask_required",
              "error_permission_rejected",
              "error_provider",
              "error_run"
            ]
          },
          "is_error": {
            "type": "boolean"
          },
          "exit_code": {
            "enum": [
              0,
              1,
              2,
              3
            ]
          },
          "thread_id": {
            "type": "string"
          },
          "duration_ms": {
            "type": "integer",
            "minimum": 0
          },
          "num_turns": {
            "type": "integer",
            "minimum": 0
          },
          "stop_reason": {
            "type": "string"
          },
          "total_usage": {
            "type": "object",
            "properties": {
              "input_tokens": {
                "type": "integer",
                "minimum": 0
              },
              "output_tokens": {
                "type": "integer",
                "minimum": 0
              },
              "cache_read_input_tokens": {
                "type": "integer",
                "minimum": 0
              },
              "cache_creation_input_tokens": {
                "type": "integer",
                "minimum": 0
              }
            },
            "required": [
              "input_tokens",
              "output_tokens"
            ],
            "additionalProperties": false
          },
          "result": {
            "type": "string"
          },
          "error": {
            "type": "string"
          }
        },
        "required": [
          "type",
          "subtype",
          "is_error",
          "exit_code",
          "thread_id",
          "duration_ms",
          "num_turns",
          "stop_reason",
          "total_usage"
        ],
        "additionalProperties": false
      }
    ]
  }
}
```

`void schema` prints exactly this document; `src/app/stream-json.test.ts`
pins the emitter and the schema together so the two cannot drift, and pins
the five v1 variant schemas byte-for-byte so the v1.1 bump can only ever be
additive.
