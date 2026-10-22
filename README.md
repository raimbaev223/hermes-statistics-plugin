# Observability — a Hermes desktop plugin

**What is Hermes doing right now, and where does all that work go?**

A dashboard for the Hermes desktop app that answers the two questions no existing
page answers together: *which agent is burning the tokens* and *what did a kanban
task actually execute*. It reads Hermes' own SQLite stores and logs — no new
server, no new telemetry pipeline, no Hermes patches.

- Page at `/observability` + sidebar row + statusbar chip + ⌘K command
- Six tabs: overview, agents, tasks, execution trace, usage, activity
- Read-only by construction: every SQLite handle is `mode=ro`
- No network, no dependencies, one Python 3 file + one ESM file
- EN / RU UI (`ctx.i18n`), follows the app theme

```
┌─────────────────────────────┐
│ Overview  Agents  Tasks  Trace  Usage  Activity │  ← page at /observability
└─────────────────────────────┘
        ▲
        │ one query key shared by page + statusbar chip (30 s)
        ▼
host.request('shell.exec')  ──►  python3 collect.py
                                     ├─ <home>/state.db                sessions, messages, session_model_usage
                                     ├─ <home>/profiles/*/state.db     the same, per profile
                                     ├─ <home>/kanban/boards/*/kanban.db  tasks, task_runs, task_events
                                     ├─ <home>/logs/agent.log          "API call #n" lines (latency, tokens)
                                     └─ <home>/logs/errors.log         ERROR / retry / tool-error lines
                                     │
                                     ▼
                     plugin-data/observability/snapshot.json  ──►  readFileText → render
```

## What it shows

| Tab | Content |
|---|---|
| **Overview** | Eight metric tiles (active agents, LLM requests, tool calls, in/out tokens, tasks, errors, retries, messages), the "top consumers — LLM requests" bar list, agents active right now, and the newest errors/retries from every profile's log. |
| **Agents** | Every Hermes profile that has history: description and group from `profile.yaml`, LLM/tool counters, tokens, cache reads, open sessions, errors, retries, and its source/model/session breakdowns. |
| **Tasks** | Kanban tasks across every board on disk, with the usage of the worker session that ran them (LLM calls, tools, tokens), run count, wall-clock duration, last finish. Filter by text, status, agent, or "only tasks with usage". |
| **Execution trace** | Click a task → the interleaved LLM steps and tool steps of its worker session: tool name, argument preview, duration, result size, error text. Ends with a reconciliation block: persisted `api_call_count` vs. steps the transcript can explain. |
| **Usage** | Per-agent and per-model tables: LLM requests with share %, input/output, cache read, tool calls, retries, cost where the provider reports pricing. |
| **Activity** | Hourly LLM-call buckets parsed from the profile logs (24 h / 72 h / all), as a bar chart plus a table with tokens and average latency per hour. |

The statusbar chip shows total LLM requests and turns red on errors; clicking it
opens the page. It shares the page's query key, so the two never run the
collector twice.

## Install

Requires the Hermes **desktop app** (the plugin is a renderer-side UI plugin) and
`python3` on `PATH`.

```bash
git clone https://github.com/raimbaev223/hermes-observability-plugin.git \
  "${HERMES_HOME:-$HOME/.hermes}/desktop-plugins/observability"
```

Then reload the app's plugin host: ⌘K / Ctrl-K → **Reload desktop plugins**
(the app also hot-loads on save). Open it from the sidebar row **Observability**,
or ⌘K → **Open Observability**.

Uninstall: delete `desktop-plugins/observability/` and reload plugins.
Update: `git -C "${HERMES_HOME:-$HOME/.hermes}/desktop-plugins/observability" pull` and reload plugins.

The plugin must live in the *root* `desktop-plugins` directory — the desktop app
loads plugins app-level, not per profile. The per-profile data it displays is
discovered by the collector, which walks `profiles/*/state.db` itself.

## How the data is read

`collect.py` is invoked as `python3 <home>/desktop-plugins/observability/collect.py`
through the gateway's `shell.exec` RPC, and writes exactly one file:
`<home>/plugin-data/observability/snapshot.json` (plus `trace-<task-id>.json` in
trace mode). The plugin reads that file back with the app's own
`readFileText` door. Nothing else is written, anywhere.

| Source | What it contributes |
|---|---|
| `state.db` (root and every `profiles/*/state.db`) | `sessions` counters (LLM calls, tool calls, tokens, cost), `messages` for execution traces, `session_model_usage` for the per-model table |
| `kanban/boards/*/kanban.db`, `kanban.db` | `tasks`, `task_runs` (worker profile, status, outcome, `metadata.worker_session_id`), `task_events` |
| `logs/agent.log` | the only per-request record Hermes keeps: `API call #n … latency=… cache=…` → hourly buckets |
| `logs/errors.log` | `ERROR` lines, connection retries, `Tool … returned error` |
| `profile.yaml` | profile description and group, for labels |

Read-only guarantees: each database is opened with `file:…?mode=ro`, statements
are wrapped so a schema drift yields empty data instead of a crash, and log
reading is capped (24 MB per file, 400 error rows, 300 sessions / 400 tasks per
board).

## Limits — read this before trusting a number

- **Per-request records are not persisted by Hermes.** Only counters are. Hourly
  activity and latency come from the log lines and therefore stop at the log
  rotation point; "all" means "as deep as the retained files go".
- **Task usage needs a link.** Tokens/tools for a task are read from its worker
  session via `task_runs.metadata.worker_session_id`. Tasks that never ran under
  the dispatcher show `—`, not zero.
- **Execution-trace LLM steps are a lower bound.** One assistant message carrying
  tool calls is drawn as one step; calls that produced no tool call (retries, final
  answers, compression/aux calls) exist only as a number. The reconciliation block
  shows the gap instead of hiding it.
- **Delegated subagents are not persisted** with a `parent_session_id` row, so the
  tree cannot be reconstructed from the database.
- Retries that happen *inside* one API call are not logged, so the retry counter
  sees connection-level retries only.
- Cost stays `—` when the provider reports no pricing.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HERMES_OBS_ROOT` | `~/.hermes` | Hermes home the collector reads. Set it only for a non-standard root; normally the plugin resolves the live `$HERMES_HOME` through the gateway shell. |

Refresh cadence is `REFRESH_MS = 30_000` at the top of `plugin.js`; the collector
`stat`s every `state.db` and tails two logs per profile, so it is not a cheap
poll — raise it on large installs.

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Observability could not collect data" | The collector exited non-zero. Run it by hand to see why: `python3 ~/.hermes/desktop-plugins/observability/collect.py`. |
| Empty page, no error | `python3` missing from the gateway's `PATH`, or `$HERMES_HOME` unresolved (the plugin falls back to the desktop bridge's plugin root). |
| Everything zero | No sessions recorded yet, or the plugin points at a different Hermes home than the one you use. |
| Chip shows no numbers | The first snapshot is still collecting (one collector run per refresh tick). |

## Layout

```
plugin.js      the whole UI: page, sidebar row, statusbar chip, ⌘K command
collect.py     read-only collector: SQLite + logs → one JSON snapshot
```

`plugin.js` is plain ESM loaded uncompiled by the app: it imports only
`@hermes/plugin-sdk`, `react`, `react/jsx-runtime`, and writes UI with `jsx()`
calls (no JSX syntax, no build step).

## License

MIT — see [LICENSE](LICENSE).
