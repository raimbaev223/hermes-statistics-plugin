#!/usr/bin/env python3
"""Statistics collector for Hermes — reads real data, writes one JSON snapshot.

Read-only by construction: every sqlite handle is opened with mode=ro.
No writes outside the snapshot dir. Invoked by the Statistics desktop plugin
via shell.exec (argv form: `python3 <this> [--mode summary|trace --task ID]`).

Data sources (all pre-existing, no Hermes changes):
  * <home>/state.db                    — per-profile sessions + messages
  * <home>/kanban/boards/*/kanban.db   — tasks, task_runs, task_events
  * <home>/logs/agent.log              — per-API-call lines (the only per-request source)
  * <home>/logs/errors.log             — agent retries / API failures
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import time
from pathlib import Path

HERMES_ROOT = Path(os.environ.get("HERMES_STATS_ROOT", str(Path.home() / ".hermes")))
OUT_DIR = HERMES_ROOT / "plugin-data" / "statistics"

MAX_SESSIONS_PER_PROFILE = 300
MAX_TASKS = 400
MAX_LOG_BYTES = 24 * 1024 * 1024


# ── helpers ──────────────────────────────────────────────────────────────────

def ro(path: Path) -> sqlite3.Connection | None:
    if not path.exists():
        return None
    try:
        c = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2.0)
        c.row_factory = sqlite3.Row
        return c
    except sqlite3.Error:
        return None


def q(conn, sql, params=()):
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    except sqlite3.Error:
        return []


def one(conn, sql, params=()):
    rows = q(conn, sql, params)
    return rows[0] if rows else {}


def profile_homes() -> list[tuple[str, Path]]:
    homes = [("default", HERMES_ROOT)]
    prof_root = HERMES_ROOT / "profiles"
    if prof_root.is_dir():
        for p in sorted(prof_root.iterdir()):
            if p.is_dir() and (p / "state.db").exists():
                homes.append((p.name, p))
    return homes


def read_profile_meta(home: Path) -> tuple[str, str]:
    """(display description, group) from profile.yaml — best effort."""
    f = home / "profile.yaml"
    if not f.exists():
        return "", ""
    try:
        raw = f.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "", ""
    desc = ""
    m = re.search(r"^description:\s*(.+)$", raw, re.M)
    if m:
        desc = m.group(1).strip().strip("'\"")
    grp = ""
    m = re.search(r"^\s*group:\s*(\S+)\s*$", raw, re.M)
    if m:
        grp = m.group(1).strip().strip("'\"")
    return desc[:200], grp


# ── sessions / usage ─────────────────────────────────────────────────────────

SESS_COLS = (
    "id, source, title, model, started_at, ended_at, message_count, tool_call_count, "
    "input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, api_call_count, "
    "estimated_cost_usd, actual_cost_usd, parent_session_id, cwd, last_activity_at, end_reason"
)


def collect_profile(name: str, home: Path) -> dict:
    db = ro(home / "state.db")
    desc, group = read_profile_meta(home)
    out: dict = {
        "name": name,
        "home": str(home),
        "description": desc,
        "group": group,
        "sessions": 0, "llm_calls": 0, "tool_calls": 0, "messages": 0,
        "input": 0, "output": 0, "cache_read": 0, "reasoning": 0,
        "cost_usd": 0.0, "active_sessions": 0, "last_activity": None,
        "by_source": [], "by_model": [], "recent": [],
    }
    if db is None:
        out["error"] = "state.db unreadable"
        return out

    t = one(db, "SELECT COUNT(*) n, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o,"
                " COALESCE(SUM(cache_read_tokens),0) c, COALESCE(SUM(reasoning_tokens),0) r,"
                " COALESCE(SUM(api_call_count),0) a, COALESCE(SUM(tool_call_count),0) tc,"
                " COALESCE(SUM(message_count),0) m, COALESCE(SUM(estimated_cost_usd),0) cost,"
                " MAX(COALESCE(last_activity_at, started_at)) last FROM sessions")
    out.update(sessions=t.get("n", 0), input=t.get("i", 0), output=t.get("o", 0),
               cache_read=t.get("c", 0), reasoning=t.get("r", 0), llm_calls=t.get("a", 0),
               tool_calls=t.get("tc", 0), messages=t.get("m", 0),
               cost_usd=round(float(t.get("cost") or 0), 6), last_activity=t.get("last"))
    out["active_sessions"] = one(db, "SELECT COUNT(*) n FROM sessions WHERE ended_at IS NULL").get("n", 0)

    out["by_source"] = q(db, """
        SELECT source, COUNT(*) sessions, COALESCE(SUM(api_call_count),0) llm_calls,
               COALESCE(SUM(tool_call_count),0) tool_calls, COALESCE(SUM(input_tokens),0) input,
               COALESCE(SUM(output_tokens),0) output, COALESCE(SUM(cache_read_tokens),0) cache_read,
               MAX(COALESCE(last_activity_at, started_at)) last
        FROM sessions GROUP BY source ORDER BY llm_calls DESC""")

    out["by_model"] = q(db, """
        SELECT model, COALESCE(SUM(api_call_count),0) llm_calls, COALESCE(SUM(input_tokens),0) input,
               COALESCE(SUM(output_tokens),0) output, COALESCE(SUM(cache_read_tokens),0) cache_read,
               COALESCE(SUM(estimated_cost_usd),0) cost
        FROM session_model_usage WHERE model IS NOT NULL AND model != ''
        GROUP BY model ORDER BY llm_calls DESC""")

    out["recent"] = q(db, f"""
        SELECT {SESS_COLS} FROM sessions
        ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT ?""", (MAX_SESSIONS_PER_PROFILE,))
    db.close()
    return out


# ── kanban ───────────────────────────────────────────────────────────────────

def collect_kanban() -> dict:
    root = HERMES_ROOT / "kanban"
    boards = []
    candidates: list[Path] = []
    if (root / "boards").is_dir():
        for d in sorted((root / "boards").iterdir()):
            if (d / "kanban.db").exists():
                candidates.append(d / "kanban.db")
    if (root / "kanban.db").exists():
        candidates.append(root / "kanban.db")
    if (HERMES_ROOT / "kanban.db").exists():
        candidates.append(HERMES_ROOT / "kanban.db")

    seen_db: set[str] = set()
    tasks: list[dict] = []
    for dbp in candidates:
        key = str(dbp.resolve())
        if key in seen_db:
            continue
        seen_db.add(key)
        conn = ro(dbp)
        if conn is None:
            continue
        slug = dbp.parent.name if dbp.parent.name != "kanban" else "default"
        ts = q(conn, """
            SELECT t.id, t.title, t.assignee, t.status, t.created_at, t.started_at,
                   t.completed_at, t.workspace_path, t.branch_name,
                   (SELECT COUNT(*) FROM task_runs r WHERE r.task_id = t.id) runs
            FROM tasks t ORDER BY t.created_at DESC LIMIT ?""", (MAX_TASKS,))
        runs = q(conn, """
            SELECT id, task_id, profile, status, outcome, started_at, ended_at,
                   worker_pid, metadata, error, summary
            FROM task_runs ORDER BY started_at DESC LIMIT ?""", (MAX_TASKS * 2,))
        events = q(conn, "SELECT task_id, kind, COUNT(*) n FROM task_events GROUP BY task_id, kind")
        n_tasks = one(conn, "SELECT COUNT(*) n FROM tasks").get("n", 0)
        n_events = one(conn, "SELECT COUNT(*) n FROM task_events").get("n", 0)
        n_runs = one(conn, "SELECT COUNT(*) n FROM task_runs").get("n", 0)
        boards.append({"slug": slug, "db": str(dbp), "tasks": n_tasks,
                       "runs": n_runs, "events": n_events})
        ev_by_task: dict[str, dict] = {}
        for e in events:
            ev_by_task.setdefault(e["task_id"], {})[e["kind"]] = e["n"]
        runs_by_task: dict[str, list] = {}
        for r in runs:
            runs_by_task.setdefault(r["task_id"], []).append(r)
        for t in ts:
            rl = runs_by_task.get(t["id"], [])
            t["board"] = slug
            t["events"] = ev_by_task.get(t["id"], {})
            t["run_count"] = len(rl)
            t["profile"] = next((r["profile"] for r in rl if r.get("profile")), None)
            t["outcome"] = next((r["outcome"] for r in rl if r.get("outcome")), None)
            t["run_status"] = rl[0]["status"] if rl else None
            t["worker_pid"] = next((r["worker_pid"] for r in rl if r.get("worker_pid")), None)
            t["worker_session_id"] = None
            t["run_error"] = next((r["error"] for r in rl if r.get("error")), None)
            t["last_run_summary"] = rl[0]["summary"] if rl else None
            t["run_started_at"] = min((r["started_at"] for r in rl if r.get("started_at")), default=None)
            t["run_ended_at"] = max((r["ended_at"] for r in rl if r.get("ended_at")), default=None)
            for r in rl:
                try:
                    md = json.loads(r.get("metadata") or "{}")
                except (ValueError, TypeError):
                    md = {}
                if md.get("worker_session_id"):
                    t["worker_session_id"] = md["worker_session_id"]
                if md.get("pr") or md.get("pr_url"):
                    t["pr"] = md.get("pr") or md.get("pr_url")
                if md.get("branch"):
                    t["branch_name"] = t.get("branch_name") or md["branch"]
            tasks.append(t)
        conn.close()
    return {"boards": boards, "tasks": tasks}


def link_task_sessions(tasks: list[dict], profile_map: dict[str, sqlite3.Connection]) -> None:
    """Attach real per-task usage from the worker's OWN session row."""
    for t in tasks:
        sid = t.get("worker_session_id")
        prof = t.get("profile")
        if not sid or prof not in profile_map:
            continue
        row = one(profile_map[prof], f"SELECT {SESS_COLS} FROM sessions WHERE id = ?", (sid,))
        if row:
            t["session"] = row
            # session row columns are *_tokens / *_count — map to the flat names the UI reads
            for src, dst in (("input_tokens", "input"), ("output_tokens", "output"),
                             ("cache_read_tokens", "cache_read"),
                             ("api_call_count", "api_call_count"),
                             ("tool_call_count", "tool_call_count"),
                             ("message_count", "message_count"), ("model", "model")):
                t[dst] = row.get(src)


# ── logs: the only per-request/per-error source ──────────────────────────────

API_CALL_RE = re.compile(
    r"^(?P<ts>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),\d+ \w+ \[(?P<sid>[^\]]*)\] "
    r"agent\.conversation_loop: API call #(?P<n>\d+): model=(?P<model>\S+) provider=(?P<prov>\S+) "
    r"in=(?P<in>\d+) out=(?P<out>\d+) total=(?P<tot>\d+) latency=(?P<lat>[\d.]+)s cache=(?P<cache>\S+)")

RETRY_RES = (
    re.compile(r"^(?P<ts>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),\d+ \w+ (?P<log>[^:]+): .*(?P<sig>API call failed|retrying|Retrying|rate.?limit|429)", re.I),
    re.compile(r"^(?P<ts>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),\d+ \w+ .*Connect attempt (?P<att>\d+)/(?P<max>\d+) failed"),
    re.compile(r"^(?P<ts>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),\d+ ERROR .*"),
    re.compile(r"^(?P<ts>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),\d+ WARNING .*Tool (?P<tool>\w+) returned error"),
)


def _ts_epoch(s: str) -> float:
    try:
        return time.mktime(time.strptime(s, "%Y-%m-%d %H:%M:%S"))
    except ValueError:
        return 0.0


def collect_logs(profile: str, home: Path) -> dict:
    res = {"api_calls": [], "llm_by_hour": {}, "errors": [], "retries": 0,
           "tool_errors": 0, "api_failures": 0, "api_calls_total": 0}
    logs = home / "logs"
    apilog = logs / "agent.log"
    if apilog.exists() and apilog.stat().st_size < MAX_LOG_BYTES:
        try:
            with apilog.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    m = API_CALL_RE.match(line)
                    if not m:
                        continue
                    res["api_calls_total"] += 1
                    hour = m.group("ts")[:13]
                    b = res["llm_by_hour"].setdefault(hour, {"llm": 0, "in": 0, "out": 0, "lat": 0.0, "n": 0})
                    b["llm"] += 1
                    b["in"] += int(m.group("in"))
                    b["out"] += int(m.group("out"))
                    b["lat"] += float(m.group("lat"))
                    b["n"] += 1
            if res["api_calls_total"]:
                last = res["api_calls_total"]
                res["api_calls"] = []  # per-call rows are huge; the hourly rollup is what the UI needs
                res["last_api_calls_seen"] = last
        except OSError:
            pass

    err = logs / "errors.log"
    if err.exists() and err.stat().st_size < MAX_LOG_BYTES:
        try:
            with err.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    for rx in RETRY_RES[1:]:
                        m = rx.match(line)
                        if not m:
                            continue
                        if "Connect attempt" in line:
                            res["retries"] += 1
                            kind = "conn_retry"
                        elif "returned error" in line:
                            res["tool_errors"] += 1
                            kind = "tool_error"
                        elif line.find(" ERROR ") > 0:
                            res["api_failures"] += 1
                            kind = "error"
                        else:
                            kind = "warn"
                        res["errors"].append({"ts": _ts_epoch(m.group("ts")),
                                              "kind": kind,
                                              "line": line.strip()[:400],
                                              "profile": profile})
                        break
        except OSError:
            pass
    # Bound the payload: newest first, capped.
    res["errors"].sort(key=lambda e: e["ts"], reverse=True)
    res["errors"] = res["errors"][:400]
    return res


# ── trace: one kanban task → its worker session → individual actions ─────────

def collect_trace(task_id: str, task: dict, profile_map: dict[str, sqlite3.Connection]) -> dict:
    """One kanban task → its worker session → interleaved LLM/tool steps.

    Individual LLM requests are NOT persisted per-request (only the session
    counter), so each assistant message that carries tool_calls is emitted as
    one LLM step — a real LOWER BOUND, labeled as such. Tool steps are the
    matching 'tool' result rows (duration + error are real).
    """
    prof = task.get("profile")
    sid = task.get("worker_session_id")
    out = {"task": task, "session": None, "events": [], "subagents": [],
           "llm_source": "one step per assistant tool-call message (lower bound)"}
    if not sid or prof not in profile_map:
        out["error"] = ("task has no worker_session_id in task_runs.metadata"
                        if not sid else f"profile {prof} not readable")
        return out
    db = profile_map[prof]
    out["session"] = one(db, f"SELECT {SESS_COLS} FROM sessions WHERE id = ?", (sid,))

    msgs = q(db, """
        SELECT id, role, tool_name, tool_call_id, timestamp, finish_reason,
               LENGTH(COALESCE(content,'')) chars, substr(COALESCE(content,''),1,240) head,
               tool_calls
        FROM messages WHERE session_id = ? AND active = 1
        ORDER BY timestamp ASC, id ASC LIMIT 4000""", (sid,))

    tool_results = [m for m in msgs if m["role"] == "tool"]
    result_idx = 0
    seq = 0
    for m in msgs:
        if m["role"] == "assistant":
            fns = []
            try:
                fns = json.loads(m["tool_calls"]) if m["tool_calls"] else []
            except (ValueError, TypeError):
                fns = []
            names = [((f.get("function") or {}).get("name") or "?") for f in fns]
            seq += 1
            out["events"].append({
                "i": seq, "kind": "llm", "ts": m["timestamp"], "step": f"API call #{seq}",
                "tools_in_step": names, "finish_reason": m["finish_reason"],
                "out_chars": m["chars"], "preview": m["head"],
            })
            for f in fns:
                fn = f.get("function") or {}
                r = tool_results[result_idx] if result_idx < len(tool_results) else None
                if r is not None:
                    result_idx += 1
                seq += 1
                err = bool(r and r["head"] and '"error"' in r["head"])
                out["events"].append({
                    "i": seq, "kind": "tool", "ts": r["timestamp"] if r else m["timestamp"],
                    "tool": fn.get("name") or "?", "args": str(fn.get("arguments") or "")[:200],
                    "duration_s": round((r["timestamp"] - m["timestamp"]), 2) if r and r["timestamp"] else None,
                    "status": "error" if err else "ok",
                    "result_chars": r["chars"] if r else None,
                    "error": (r["head"] if err else None),
                    "call_id": f.get("id") or f.get("call_id"),
                })
        elif m["role"] == "user":
            seq += 1
            out["events"].append({"i": seq, "kind": "user", "ts": m["timestamp"],
                                  "chars": m["chars"], "preview": m["head"]})
    out["step_count"] = len(out["events"])
    out["tool_count"] = sum(1 for e in out["events"] if e["kind"] == "tool")
    out["llm_count"] = sum(1 for e in out["events"] if e["kind"] == "llm")
    out["errors"] = sum(1 for e in out["events"] if e.get("status") == "error")
    # Reconcile the persisted counter against what the transcript can explain.
    # A gap is real information: calls that produced no tool call (retries,
    # final answers, compression/aux calls) are only visible as a number.
    counter = (out.get("session") or {}).get("api_call_count") or 0
    out["reconciliation"] = {
        "session_api_call_counter": counter,
        "steps_with_tool_calls": out["llm_count"],
        "unexplained_calls": max(0, counter - out["llm_count"]),
        "note": ("calls beyond 'steps_with_tool_calls' left no tool call in the transcript — "
                 "retries, final answers, compression/aux calls. Only the total is persisted."),
    }
    return out


# ── main ─────────────────────────────────────────────────────────────────────

def build_summary() -> dict:
    t0 = time.time()
    homes = profile_homes()
    profiles = [collect_profile(n, h) for n, h in homes]
    kanban = collect_kanban()

    conns: dict[str, sqlite3.Connection] = {}
    for n, h in homes:
        c = ro(h / "state.db")
        if c is not None:
            conns[n] = c
    link_task_sessions(kanban["tasks"], conns)

    logs = {}
    for n, h in homes:
        lg = collect_logs(n, h)
        logs[n] = lg
        for p in profiles:
            if p["name"] == n:
                p["retries"] = lg["retries"]
                p["api_failures"] = lg["api_failures"]
                p["tool_errors"] = lg["tool_errors"]
                p["api_calls_logged"] = lg.get("last_api_calls_seen", 0)
                p["llm_by_hour"] = lg["llm_by_hour"]

    totals = {
        "profiles": len([p for p in profiles if p["sessions"]]),
        "sessions": sum(p["sessions"] for p in profiles),
        "llm_calls": sum(p["llm_calls"] for p in profiles),
        "tool_calls": sum(p["tool_calls"] for p in profiles),
        "messages": sum(p["messages"] for p in profiles),
        "input": sum(p["input"] for p in profiles),
        "output": sum(p["output"] for p in profiles),
        "cache_read": sum(p["cache_read"] for p in profiles),
        "cost_usd": round(sum(p["cost_usd"] for p in profiles), 4),
        "retries": sum(l["retries"] for l in logs.values()),
        "api_failures": sum(l["api_failures"] for l in logs.values()),
        "tool_errors": sum(l["tool_errors"] for l in logs.values()),
        "tasks": len(kanban["tasks"]),
        "boards": len(kanban["boards"]),
    }

    # one merged hourly activity timeline across profiles
    hours: dict[str, dict] = {}
    for n, lg in logs.items():
        for hh, b in lg["llm_by_hour"].items():
            tgt = hours.setdefault(hh, {"hour": hh, "llm": 0, "in": 0, "out": 0, "lat": 0.0, "n": 0})
            tgt["llm"] += b["llm"]
            tgt["in"] += b["in"]
            tgt["out"] += b["out"]
            tgt["lat"] += b["lat"]
            tgt["n"] += b["n"]
    timeline = sorted(hours.values(), key=lambda x: x["hour"])
    for b in timeline:
        b["avg_latency"] = round(b["lat"] / b["n"], 2) if b["n"] else 0
        b.pop("lat", None)
        b.pop("n", None)

    # error rollup by profile/kind
    err_by: dict[tuple, int] = {}
    for n, lg in logs.items():
        for e in lg["errors"]:
            err_by[(n, e["kind"])] = err_by.get((n, e["kind"]), 0) + 1
    error_rollup = sorted(
        [{"profile": k[0], "kind": k[1], "count": v} for k, v in err_by.items()],
        key=lambda x: -x["count"])

    for c in conns.values():
        try:
            c.close()
        except sqlite3.Error:
            pass

    # top consumers (the "token genocide" board)
    consumers = sorted(
        [{"agent": p["name"], "group": p["group"], "llm_calls": p["llm_calls"],
          "tool_calls": p["tool_calls"], "input": p["input"], "output": p["output"],
          "cache_read": p["cache_read"], "sessions": p["sessions"],
          "cost_usd": p["cost_usd"], "retries": p.get("retries", 0),
          "api_failures": p.get("api_failures", 0),
          "last_activity": p["last_activity"]} for p in profiles],
        key=lambda x: -x["llm_calls"])

    return {
        "generated_at": time.time(),
        "build_ms": int((time.time() - t0) * 1000),
        "hermes_root": str(HERMES_ROOT),
        "totals": totals,
        "profiles": profiles,
        "consumers": consumers,
        "boards": kanban["boards"],
        "tasks": kanban["tasks"],
        "timeline": timeline,
        "error_rollup": error_rollup,
        "recent_errors": sorted(
            [e for lg in logs.values() for e in lg["errors"]], key=lambda e: -e["ts"])[:120],
        "notes": {
            "llm_requests": "per-call counts come from sessions.api_call_count; "
                            "hourly series parsed from logs/agent.log API-call lines",
            "task_usage": "a kanban task's tokens/tools come from its worker session "
                          "(task_runs.metadata.worker_session_id -> profile state.db)",
            "subagent_tree": "not persisted: delegated children have no parent_session_id row",
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="summary", choices=["summary", "trace"])
    ap.add_argument("--task", default="")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    if args.mode == "trace":
        if not args.task:
            print(json.dumps({"error": "trace needs --task <id>"}))
            return 2
        kanban = collect_kanban()
        task = next((t for t in kanban["tasks"] if t["id"] == args.task), None)
        if task is None:
            print(json.dumps({"error": f"unknown task {args.task}"}))
            return 3
        conns = {}
        for n, h in profile_homes():
            c = ro(h / "state.db")
            if c is not None:
                conns[n] = c
        trace = collect_trace(args.task, task, conns)
        for c in conns.values():
            c.close()
        path = OUT_DIR / f"trace-{args.task}.json"
        path.write_text(json.dumps(trace, ensure_ascii=False, default=str), encoding="utf-8")
        print(json.dumps({"ok": True, "path": str(path),
                          "steps": trace.get("step_count", 0),
                          "llm": trace.get("llm_count", 0),
                          "tools": trace.get("tool_count", 0),
                          "tool_errors": trace.get("errors", 0),
                          "error": trace.get("error")}))
        return 0

    snap = build_summary()
    path = Path(args.out) if args.out else OUT_DIR / "snapshot.json"
    path.write_text(json.dumps(snap, ensure_ascii=False, default=str), encoding="utf-8")
    print(json.dumps({
        "ok": True, "path": str(path), "bytes": path.stat().st_size,
        "build_ms": snap["build_ms"], "totals": snap["totals"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
