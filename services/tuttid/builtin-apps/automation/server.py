import json
import os
import re
import shlex
import signal
import sqlite3
import subprocess
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

PACKAGE_DIR = Path(os.environ["TUTTI_APP_PACKAGE_DIR"])
DATA_DIR = Path(os.environ["TUTTI_APP_DATA_DIR"])
LOG_DIR = Path(os.environ["TUTTI_APP_LOG_DIR"])
RUNTIME_DIR = Path(os.environ["TUTTI_APP_RUNTIME_DIR"])
WORKSPACE_ROOT = os.environ.get("TUTTI_WORKSPACE_ROOT", "").strip()
WORKSPACE_ID = os.environ["TUTTI_WORKSPACE_ID"]
WORKSPACE_NAME = os.environ.get("TUTTI_WORKSPACE_NAME", WORKSPACE_ID)
DB_PATH = DATA_DIR / "automation.sqlite3"
LEGACY_TIMEOUT_SECONDS = 0
PROJECT_MARKERS = ("package.json", "go.mod", "pyproject.toml", "Cargo.toml", ".git")
RESULT_STATUS_VALUES = {"success", "fail", "skip"}
DEFAULT_AGENT_PROVIDER = "codex"
AUTOMATION_SUPPORTED_AGENT_PROVIDERS = {"claude-code", "codex", "gemini"}

DATA_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)
RUNTIME_DIR.mkdir(parents=True, exist_ok=True)


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def parse_iso(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def automation_id():
    return "aut_" + uuid.uuid4().hex[:16]


def run_id():
    return "run_" + uuid.uuid4().hex[:16]


def run_artifact_dir(automation_id, run_id_):
    return LOG_DIR / "runs" / automation_id / run_id_


def connect_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


class Store:
    def __init__(self, path):
        self.path = path
        self.lock = threading.RLock()
        self.db = connect_db()
        self.migrate()
        self.recover_interrupted_runs()

    def migrate(self):
        with self.lock:
            self.db.executescript(
                """
                CREATE TABLE IF NOT EXISTS automations (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  prompt TEXT NOT NULL,
                  cwd TEXT NOT NULL,
                  enabled INTEGER NOT NULL,
                  schedule_type TEXT NOT NULL,
                  schedule_json TEXT NOT NULL,
                  concurrency TEXT NOT NULL,
                  timeout_seconds INTEGER NOT NULL,
                  runner_settings_json TEXT NOT NULL DEFAULT '{}',
                  runner_args_json TEXT NOT NULL,
                  env_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  next_run_at TEXT
                );
                CREATE TABLE IF NOT EXISTS runs (
                  id TEXT PRIMARY KEY,
                  automation_id TEXT NOT NULL,
                  trigger TEXT NOT NULL,
                  status TEXT NOT NULL,
                  prompt TEXT NOT NULL,
                  cwd TEXT NOT NULL,
                  queued_at TEXT NOT NULL,
                  started_at TEXT,
                  finished_at TEXT,
                  exit_code INTEGER,
                  summary TEXT,
                  error TEXT,
                  result_status TEXT,
                  artifact_dir TEXT NOT NULL,
                  agent_session_id TEXT,
                  agent_provider TEXT,
                  reviewed_at TEXT,
                  FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE
                );
                """
            )
            self.ensure_column("runs", "result_status", "TEXT")
            self.ensure_column("runs", "agent_session_id", "TEXT")
            self.ensure_column("runs", "agent_provider", "TEXT")
            self.ensure_column("automations", "runner_settings_json", "TEXT NOT NULL DEFAULT '{}'")

    def ensure_column(self, table, column, definition):
        columns = {row["name"] for row in self.db.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in columns:
            self.db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    def recover_interrupted_runs(self):
        with self.lock:
            stamp = now_iso()
            self.db.execute(
                """
                UPDATE runs
                SET status='failed', finished_at=?, error='The app restarted before this run finished.'
                WHERE status IN ('queued', 'running', 'canceling')
                """,
                (stamp,),
            )
            self.db.commit()

    def list_automations(self):
        with self.lock:
            rows = self.db.execute(
                """
                SELECT automations.*,
                  (
                    SELECT started_at FROM runs
                    WHERE runs.automation_id=automations.id AND started_at IS NOT NULL
                    ORDER BY started_at DESC LIMIT 1
                  ) AS last_run_at,
                  (
                    SELECT id FROM runs
                    WHERE runs.automation_id=automations.id AND status IN ('queued', 'running', 'canceling')
                    ORDER BY queued_at DESC LIMIT 1
                  ) AS active_run_id,
                  (
                    SELECT status FROM runs
                    WHERE runs.automation_id=automations.id AND status IN ('queued', 'running', 'canceling')
                    ORDER BY queued_at DESC LIMIT 1
                  ) AS active_run_status,
                  (
                    SELECT COUNT(*) FROM runs
                    WHERE runs.automation_id=automations.id AND finished_at IS NOT NULL AND reviewed_at IS NULL
                      AND COALESCE(result_status, status) != 'skip'
                  ) AS unreviewed_run_count,
                  (
                    SELECT COUNT(*) FROM runs
                    WHERE runs.automation_id=automations.id AND finished_at IS NOT NULL AND reviewed_at IS NULL
                      AND COALESCE(result_status, status) IN ('fail', 'failed', 'timed_out')
                  ) AS unreviewed_failed_run_count
                FROM automations
                ORDER BY updated_at DESC
                """
            ).fetchall()
            return [decode_automation(row) for row in rows]

    def get_automation(self, id_):
        with self.lock:
            row = self.db.execute(
                """
                SELECT automations.*,
                  (
                    SELECT started_at FROM runs
                    WHERE runs.automation_id=automations.id AND started_at IS NOT NULL
                    ORDER BY started_at DESC LIMIT 1
                  ) AS last_run_at,
                  (
                    SELECT id FROM runs
                    WHERE runs.automation_id=automations.id AND status IN ('queued', 'running', 'canceling')
                    ORDER BY queued_at DESC LIMIT 1
                  ) AS active_run_id,
                  (
                    SELECT status FROM runs
                    WHERE runs.automation_id=automations.id AND status IN ('queued', 'running', 'canceling')
                    ORDER BY queued_at DESC LIMIT 1
                  ) AS active_run_status,
                  (
                    SELECT COUNT(*) FROM runs
                    WHERE runs.automation_id=automations.id AND finished_at IS NOT NULL AND reviewed_at IS NULL
                      AND COALESCE(result_status, status) != 'skip'
                  ) AS unreviewed_run_count,
                  (
                    SELECT COUNT(*) FROM runs
                    WHERE runs.automation_id=automations.id AND finished_at IS NOT NULL AND reviewed_at IS NULL
                      AND COALESCE(result_status, status) IN ('fail', 'failed', 'timed_out')
                  ) AS unreviewed_failed_run_count
                FROM automations
                WHERE id=?
                """,
                (id_,),
            ).fetchone()
            return decode_automation(row) if row else None

    def save_automation(self, item):
        with self.lock:
            self.db.execute(
                """
                INSERT INTO automations (
                  id, name, prompt, cwd, enabled, schedule_type, schedule_json,
                  concurrency, timeout_seconds, runner_settings_json, runner_args_json, env_json,
                  created_at, updated_at, next_run_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  name=excluded.name,
                  prompt=excluded.prompt,
                  cwd=excluded.cwd,
                  enabled=excluded.enabled,
                  schedule_type=excluded.schedule_type,
                  schedule_json=excluded.schedule_json,
                  concurrency=excluded.concurrency,
                  timeout_seconds=excluded.timeout_seconds,
                  runner_settings_json=excluded.runner_settings_json,
                  runner_args_json=excluded.runner_args_json,
                  env_json=excluded.env_json,
                  updated_at=excluded.updated_at,
                  next_run_at=excluded.next_run_at
                """,
                (
                    item["id"],
                    item["name"],
                    item["prompt"],
                    item["cwd"],
                    1 if item["enabled"] else 0,
                    item["scheduleType"],
                    json.dumps(item["schedule"], separators=(",", ":")),
                    item["concurrency"],
                    LEGACY_TIMEOUT_SECONDS,
                    json.dumps(item["runnerSettings"], separators=(",", ":")),
                    json.dumps(item["runnerArgs"], separators=(",", ":")),
                    json.dumps(item["env"], separators=(",", ":")),
                    item["createdAt"],
                    item["updatedAt"],
                    item.get("nextRunAt"),
                ),
            )
            self.db.commit()
            return self.get_automation(item["id"])

    def delete_automation(self, id_):
        with self.lock:
            result = self.db.execute("DELETE FROM automations WHERE id=?", (id_,))
            self.db.commit()
            return result.rowcount > 0

    def set_automation_enabled(self, id_, enabled):
        item = self.get_automation(id_)
        if not item:
            return None
        item["enabled"] = bool(enabled)
        item["updatedAt"] = now_iso()
        item["nextRunAt"] = compute_next_run(item, datetime.now(timezone.utc))
        return self.save_automation(item)

    def list_due_automations(self):
        with self.lock:
            rows = self.db.execute(
                """
                SELECT * FROM automations
                WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= ?
                ORDER BY next_run_at ASC
                """,
                (now_iso(),),
            ).fetchall()
            return [decode_automation(row) for row in rows]

    def next_scheduled_run_at(self):
        with self.lock:
            rows = self.db.execute(
                """
                SELECT next_run_at FROM automations
                WHERE enabled=1 AND next_run_at IS NOT NULL
                """
            ).fetchall()
            times = [parse_iso(row["next_run_at"]) for row in rows]
            times = [value for value in times if value is not None]
            return min(times) if times else None

    def list_runs(self, automation_id=None, limit=100):
        with self.lock:
            if automation_id:
                rows = self.db.execute(
                    """
                    SELECT * FROM runs WHERE automation_id=?
                    ORDER BY queued_at DESC LIMIT ?
                    """,
                    (automation_id, limit),
                ).fetchall()
            else:
                rows = self.db.execute(
                    "SELECT * FROM runs ORDER BY queued_at DESC LIMIT ?", (limit,)
                ).fetchall()
            return [decode_run(row) for row in rows]

    def get_run(self, id_):
        with self.lock:
            row = self.db.execute("SELECT * FROM runs WHERE id=?", (id_,)).fetchone()
            return decode_run(row) if row else None

    def save_run(self, item):
        with self.lock:
            self.db.execute(
                """
                INSERT INTO runs (
                  id, automation_id, trigger, status, prompt, cwd, queued_at,
                  started_at, finished_at, exit_code, summary, error, result_status, artifact_dir,
                  agent_session_id, agent_provider, reviewed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  status=excluded.status,
                  started_at=excluded.started_at,
                  finished_at=excluded.finished_at,
                  exit_code=excluded.exit_code,
                  summary=excluded.summary,
                  error=excluded.error,
                  result_status=COALESCE(runs.result_status, excluded.result_status),
                  artifact_dir=excluded.artifact_dir,
                  agent_session_id=excluded.agent_session_id,
                  agent_provider=excluded.agent_provider,
                  reviewed_at=excluded.reviewed_at
                """,
                (
                    item["id"],
                    item["automationId"],
                    item["trigger"],
                    item["runStatus"],
                    item["prompt"],
                    item["cwd"],
                    item["queuedAt"],
                    item.get("startedAt"),
                    item.get("finishedAt"),
                    item.get("exitCode"),
                    item.get("summary"),
                    item.get("error"),
                    item.get("taskStatus"),
                    item["artifactDir"],
                    item.get("agentSessionId"),
                    item.get("agentProvider"),
                    item.get("reviewedAt"),
                ),
            )
            self.db.commit()
            return self.get_run(item["id"])

    def complete_run(self, id_, result_status):
        with self.lock:
            row = self.db.execute("SELECT * FROM runs WHERE id=?", (id_,)).fetchone()
            if not row:
                raise ValueError(f"run {id_} was not found")
            if row["status"] not in {"running"}:
                raise ValueError("run is not accepting completion")
            self.db.execute(
                """
                UPDATE runs
                SET result_status=?
                WHERE id=?
                """,
                (result_status, id_),
            )
            self.db.commit()
            return self.get_run(id_)

    def has_active_run(self, automation_id):
        with self.lock:
            row = self.db.execute(
                """
                SELECT id FROM runs
                WHERE automation_id=? AND status IN ('queued', 'running', 'canceling')
                LIMIT 1
                """,
                (automation_id,),
            ).fetchone()
            return row["id"] if row else None


def decode_automation(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "prompt": row["prompt"],
        "cwd": row["cwd"],
        "enabled": bool(row["enabled"]),
        "scheduleType": row["schedule_type"],
        "schedule": json.loads(row["schedule_json"]),
        "concurrency": row["concurrency"],
        "runnerSettings": decode_runner_settings(
            row_get(row, "runner_settings_json"),
            row["runner_args_json"],
        ),
        "runnerArgs": json.loads(row["runner_args_json"]),
        "env": json.loads(row["env_json"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "nextRunAt": row["next_run_at"],
        "lastRunAt": row_get(row, "last_run_at"),
        "activeRunId": row_get(row, "active_run_id"),
        "activeRunStatus": row_get(row, "active_run_status"),
        "unreviewedRunCount": row_get(row, "unreviewed_run_count", 0),
        "unreviewedFailedRunCount": row_get(row, "unreviewed_failed_run_count", 0),
    }


def decode_run(row):
    return {
        "id": row["id"],
        "automationId": row["automation_id"],
        "trigger": row["trigger"],
        "runStatus": row["status"],
        "prompt": row["prompt"],
        "cwd": row["cwd"],
        "queuedAt": row["queued_at"],
        "startedAt": row["started_at"],
        "finishedAt": row["finished_at"],
        "exitCode": row["exit_code"],
        "summary": row["summary"],
        "error": row["error"],
        "taskStatus": row_get(row, "result_status"),
        "artifactDir": row["artifact_dir"],
        "agentSessionId": row_get(row, "agent_session_id"),
        "agentProvider": row_get(row, "agent_provider"),
        "reviewedAt": row["reviewed_at"],
    }


def row_get(row, key, default=None):
    try:
        return row[key]
    except (KeyError, IndexError):
        return default


def decode_runner_settings(settings_json, args_json=None):
    settings = {}
    if settings_json:
        try:
            parsed = json.loads(settings_json)
            if isinstance(parsed, dict):
                settings = parsed
        except Exception:
            settings = {}
    args = []
    if args_json:
        try:
            parsed_args = json.loads(args_json)
            if isinstance(parsed_args, list):
                args = parsed_args
        except Exception:
            args = []
    return normalize_runner_settings(settings, None, args)


def normalize_automation(payload, existing=None):
    stamp = now_iso()
    schedule_type = clean_choice(
        payload.get("scheduleType", existing["scheduleType"] if existing else "manual"),
        {"manual", "interval", "daily", "weekly", "cron"},
        "manual",
    )
    item = {
        "id": existing["id"] if existing else automation_id(),
        "name": clean_required(payload.get("name"), "name"),
        "prompt": clean_required(payload.get("prompt"), "prompt"),
        "cwd": clean_cwd(payload.get("cwd") or (existing["cwd"] if existing else "")),
        "enabled": bool(payload.get("enabled", existing["enabled"] if existing else True)),
        "scheduleType": schedule_type,
        "schedule": normalize_schedule(schedule_type, payload.get("schedule", {})),
        "concurrency": clean_choice(
            payload.get("concurrency", existing["concurrency"] if existing else "queue"),
            {"skip", "queue", "replace"},
            "queue",
        ),
        "runnerSettings": normalize_runner_settings(
            payload.get("runnerSettings"),
            existing["runnerSettings"] if existing else None,
            payload.get("runnerArgs", existing["runnerArgs"] if existing else []),
        ),
        "runnerArgs": clean_string_list(payload.get("runnerArgs", existing["runnerArgs"] if existing else [])),
        "env": clean_env(payload.get("env", existing["env"] if existing else {})),
        "createdAt": existing["createdAt"] if existing else stamp,
        "updatedAt": stamp,
    }
    item["nextRunAt"] = compute_next_run(item, datetime.now(timezone.utc))
    return item


def normalize_runner_settings(value, existing=None, runner_args=None):
    value = value if isinstance(value, dict) else {}
    existing = existing if isinstance(existing, dict) else {}
    parsed_args = parse_runner_args(clean_string_list(runner_args or []))
    provider = clean_provider(
        value.get("provider") or existing.get("provider") or DEFAULT_AGENT_PROVIDER
    )
    return {
        "provider": provider,
        "model": clean_optional_string(
            value.get("model") or existing.get("model") or parsed_args.get("model")
        ),
        "reasoningEffort": clean_optional_string(
            value.get("reasoningEffort")
            or existing.get("reasoningEffort")
            or parsed_args.get("reasoningEffort")
        ),
        "permissionMode": clean_optional_string(
            value.get("permissionMode") or existing.get("permissionMode")
        ),
    }


def parse_runner_args(args):
    result = {"model": "", "reasoningEffort": ""}
    index = 0
    while index < len(args):
        arg = str(args[index] or "").strip()
        if arg in ("--model", "-m") and index + 1 < len(args):
            result["model"] = str(args[index + 1] or "").strip()
            index += 2
            continue
        if arg.startswith("--model="):
            result["model"] = arg.removeprefix("--model=").strip()
            index += 1
            continue
        if arg in ("--config", "-c") and index + 1 < len(args):
            read_reasoning_config(str(args[index + 1] or ""), result)
            index += 2
            continue
        if arg.startswith("--config="):
            read_reasoning_config(arg.removeprefix("--config="), result)
        index += 1
    return result


def read_reasoning_config(value, result):
    match = re.match(r"^model_reasoning_effort=(.*)$", str(value or "").strip())
    if match:
        result["reasoningEffort"] = match.group(1).strip().strip("\"'")


def normalize_schedule(schedule_type, value):
    value = value if isinstance(value, dict) else {}
    if schedule_type == "interval":
        return {"intervalMinutes": clean_int(value.get("intervalMinutes", 60), 1, 60 * 24 * 30)}
    if schedule_type == "daily":
        return {"timeOfDay": clean_time(value.get("timeOfDay", "09:00"))}
    if schedule_type == "weekly":
        return {
            "timeOfDay": clean_time(value.get("timeOfDay", "09:00")),
            "daysOfWeek": clean_days(value.get("daysOfWeek", [1])),
        }
    if schedule_type == "cron":
        return {"expression": clean_required(value.get("expression", "0 9 * * *"), "cron expression")}
    return {}


def compute_next_run(item, after):
    if not item["enabled"] or item["scheduleType"] == "manual":
        return None
    schedule = item["schedule"]
    if item["scheduleType"] == "interval":
        if schedule["intervalMinutes"] == 60:
            local_after = after.astimezone()
            candidate = local_after.replace(
                minute=0,
                second=0,
                microsecond=0,
            ) + timedelta(hours=1)
            return candidate.astimezone(timezone.utc).isoformat()
        return (after + timedelta(minutes=schedule["intervalMinutes"])).replace(microsecond=0).isoformat()
    if item["scheduleType"] in ("daily", "weekly"):
        local_after = after.astimezone()
        hour, minute = [int(part) for part in schedule["timeOfDay"].split(":")]
        days = schedule.get("daysOfWeek") if item["scheduleType"] == "weekly" else None
        for offset in range(0, 15):
            candidate = local_after.replace(hour=hour, minute=minute, second=0, microsecond=0) + timedelta(days=offset)
            if candidate <= local_after:
                continue
            if days is None or candidate.isoweekday() in days:
                return candidate.astimezone(timezone.utc).isoformat()
    if item["scheduleType"] == "cron":
        return next_cron_time(schedule["expression"], after).isoformat()
    return None


def next_cron_time(expression, after):
    fields = expression.split()
    if len(fields) != 5:
        raise ValueError("cron expression must contain five fields")
    current = after.astimezone().replace(second=0, microsecond=0) + timedelta(minutes=1)
    for _ in range(0, 366 * 24 * 60):
        if cron_matches(fields, current):
            return current.astimezone(timezone.utc)
        current += timedelta(minutes=1)
    raise ValueError("cron expression has no match in the next year")


def cron_matches(fields, moment):
    values = [moment.minute, moment.hour, moment.day, moment.month, moment.isoweekday() % 7]
    ranges = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)]
    return all(cron_field_matches(field, value, low, high) for field, value, (low, high) in zip(fields, values, ranges))


def cron_field_matches(field, value, low, high):
    if field == "*":
        return True
    for part in field.split(","):
        step = 1
        if "/" in part:
            part, raw_step = part.split("/", 1)
            step = int(raw_step)
        if part == "*":
            start, end = low, high
        elif "-" in part:
            raw_start, raw_end = part.split("-", 1)
            start, end = int(raw_start), int(raw_end)
        else:
            start = end = int(part)
        if start <= value <= end and (value - start) % step == 0:
            return True
    return False


def clean_required(value, label):
    value = str(value or "").strip()
    if not value:
        raise ValueError(f"{label} is required")
    return value


def clean_optional_string(value):
    if isinstance(value, bool):
        return ""
    return str(value or "").strip()


def clean_first_string(value, *keys):
    if not isinstance(value, dict):
        return ""
    for key in keys:
        text = clean_optional_string(value.get(key))
        if text:
            return text
    return ""


def clean_provider(value):
    return normalize_provider_id(value) or DEFAULT_AGENT_PROVIDER


def normalize_provider_id(value):
    value = str(value or "").strip().lower()
    aliases = {
        "claude": "claude-code",
        "gemini-cli": "gemini",
        "hermes-agent": "hermes",
        "tutti": "nexight",
        "open-claw": "openclaw",
    }
    return aliases.get(value, value)


def normalize_locale(value):
    value = str(value or "").strip().replace("_", "-").lower()
    if value == "zh" or value.startswith("zh-"):
        return "zh-CN"
    if value == "en" or value.startswith("en-"):
        return "en"
    return ""


def clean_cwd(value):
    value = str(value or WORKSPACE_ROOT or str(Path.home())).strip()
    if not value:
        raise ValueError("cwd is required")
    path = Path(value).expanduser()
    if not path.is_dir():
        raise ValueError("cwd must be an existing directory")
    return str(path)


def clean_choice(value, allowed, default):
    value = str(value or default).strip()
    return value if value in allowed else default


def clean_int(value, minimum, maximum):
    value = int(value)
    return max(minimum, min(maximum, value))


def clean_string_list(value):
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def without_duplicate_runner_flags(args, flags):
    return [arg for arg in args if arg not in flags]


def tutti_cli_command():
    configured = os.environ.get("TUTTI_CLI", "").strip()
    if not configured:
        raise RuntimeError("TUTTI_CLI is not configured")
    return configured


def run_tutti_cli(args, timeout=60, log_file=None):
    command_path = tutti_cli_command()
    command = [command_path, "--json", *args]
    if log_file:
        log_file.write(("Command: " + " ".join(command) + "\n").encode("utf-8"))
        log_file.flush()
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"TUTTI_CLI executable was not found: {command_path}") from exc
    if log_file:
        if result.stdout:
            log_file.write(result.stdout.encode("utf-8"))
            if not result.stdout.endswith("\n"):
                log_file.write(b"\n")
        if result.stderr:
            log_file.write(result.stderr.encode("utf-8"))
            if not result.stderr.endswith("\n"):
                log_file.write(b"\n")
        log_file.flush()
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "tutti cli command failed").strip()
        raise RuntimeError(message)
    if not result.stdout.strip():
        return {}
    return json.loads(result.stdout)


def start_agent_session(automation, run, log_file):
    title = automation["name"] or "Automation"
    settings = normalize_runner_settings(
        automation.get("runnerSettings"),
        None,
        automation.get("runnerArgs"),
    )
    args = [
        "agent",
        "start",
        "--provider",
        settings["provider"],
        "--cwd",
        run["cwd"],
        "--title",
        title,
        "--prompt",
        build_run_prompt(run["prompt"], run),
        "--display-prompt",
        build_run_display_prompt(automation, run),
    ]
    args.append("--show" if run.get("trigger") == "manual" else "--visible")
    if settings.get("model"):
        args.extend(["--model", settings["model"]])
    if settings.get("reasoningEffort"):
        args.extend(["--reasoning-effort", settings["reasoningEffort"]])
    if settings.get("permissionMode"):
        args.extend(["--permission-mode", settings["permissionMode"]])
    return run_tutti_cli(
        args,
        timeout=60,
        log_file=log_file,
    ).get("session") or {}


def get_agent_session(agent_session_id, log_file=None):
    return run_tutti_cli(
        ["agent", "get", "--session-id", agent_session_id],
        timeout=30,
        log_file=log_file,
    ).get("session") or {}


def cancel_agent_session(agent_session_id):
    if not agent_session_id:
        return
    run_tutti_cli(["agent", "cancel", "--session-id", agent_session_id], timeout=30)


def open_agent_session(agent_session_id):
    if not agent_session_id:
        raise ValueError("run does not have an agent session")
    return run_tutti_cli(["agent", "open", "--session-id", agent_session_id], timeout=30)


def agent_session_messages(agent_session_id, log_file=None):
    result = run_tutti_cli(
        ["agent", "session", "messages", "--session-id", agent_session_id, "--limit", "80"],
        timeout=30,
        log_file=log_file,
    )
    return result.get("messages") or []


def latest_agent_summary(agent_session_id, log_file=None):
    return latest_agent_summary_from_messages(agent_session_messages(agent_session_id, log_file=log_file))


def latest_agent_summary_from_messages(messages):
    sorted_messages = sorted(
        [message for message in messages if isinstance(message, dict)],
        key=lambda message: int(message.get("version") or message.get("id") or 0),
        reverse=True,
    )
    for message in sorted_messages:
        role = str(message.get("role") or "").strip().lower()
        if role not in {"assistant", "agent"}:
            continue
        text = extract_message_text(message.get("payload"))
        if text:
            return text
    for message in sorted_messages:
        text = extract_message_text(message.get("payload"))
        if text:
            return text
    return None


def extract_message_text(value):
    if value is None:
        return None
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, list):
        parts = [extract_message_text(item) for item in value]
        text = "\n".join(part for part in parts if part)
        return text.strip() or None
    if isinstance(value, dict):
        for key in ("content", "text", "markdown", "message"):
            text = extract_message_text(value.get(key))
            if text:
                return text
        if "parts" in value:
            text = extract_message_text(value.get("parts"))
            if text:
                return text
        if "items" in value:
            text = extract_message_text(value.get("items"))
            if text:
                return text
        return None
    return str(value).strip() or None


def terminal_agent_status(status):
    value = str(status or "").strip().lower()
    if value in {"completed", "created", "idle", "ready"}:
        return "succeeded", None
    if value == "failed":
        return "failed", None
    if value == "waiting_approval":
        return (
            "failed",
            "Agent requested approval; automation runs cannot wait for interactive approval.",
        )
    if value in {"canceled", "cancelled"}:
        return "canceled", "Canceled by user."
    return None, None


def clean_env(value):
    if not isinstance(value, dict):
        return {}
    result = {}
    for key, val in value.items():
        key = str(key).strip()
        if key:
            result[key] = str(val)
    return result


def clean_time(value):
    value = str(value or "09:00").strip()
    parts = value.split(":")
    if len(parts) != 2:
        return "09:00"
    hour, minute = int(parts[0]), int(parts[1])
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        return "09:00"
    return f"{hour:02d}:{minute:02d}"


def clean_days(value):
    if not isinstance(value, list):
        return [1]
    days = sorted({clean_int(day, 1, 7) for day in value})
    return days or [1]


def runner_options_payload(provider=None, locale=None):
    providers_payload = agent_providers_payload()
    providers = providers_payload["providers"]
    if not providers:
        return empty_runner_options_payload()
    default_provider = default_provider_from_list(
        providers,
        providers_payload.get("defaultProvider"),
    )
    provider = normalize_provider_id(provider) or default_provider
    if not any(item.get("provider") == provider for item in providers):
        provider = default_provider
    options = agent_composer_options_payload(provider, locale)
    return {
        "available": True,
        "provider": provider,
        "defaultProvider": default_provider,
        "providers": providers,
        "models": options["models"],
        "currentModel": options["currentModel"],
        "currentReasoningLevel": options["currentReasoningLevel"],
        "permissionMode": options["permissionMode"],
        "permissionConfig": options["permissionConfig"],
    }


def empty_runner_options_payload():
    return {
        "available": False,
        "provider": "",
        "defaultProvider": "",
        "providers": [],
        "models": [],
        "currentModel": "",
        "currentReasoningLevel": "",
        "permissionMode": "",
        "permissionConfig": {"configurable": False, "modes": []},
    }


def agent_providers_payload():
    result = run_tutti_cli(["agent", "providers"], timeout=30)
    providers = []
    for item in result.get("providers") or []:
        if not isinstance(item, dict):
            continue
        provider = normalize_provider_id(item.get("provider"))
        status = str(item.get("status") or "").strip()
        if (
            not provider
            or not is_supported_provider_status(status)
            or not is_automation_supported_agent_provider(provider)
        ):
            continue
        providers.append(
            {
                "provider": provider,
                "status": status,
                "detail": str(item.get("detail") or item.get("message") or "").strip(),
            }
        )
    return {
        "defaultProvider": normalize_provider_id(result.get("defaultProvider")),
        "providers": providers,
    }


def is_supported_provider_status(status):
    return str(status or "").strip().lower() in {"available", "ready"}


def is_automation_supported_agent_provider(provider):
    return normalize_provider_id(provider) in AUTOMATION_SUPPORTED_AGENT_PROVIDERS


def default_provider_from_list(providers, preferred=None):
    preferred = normalize_provider_id(preferred)
    if preferred:
        for item in providers:
            if (
                normalize_provider_id(item.get("provider")) == preferred
                and is_supported_provider_status(item.get("status"))
            ):
                return preferred
    for item in providers:
        if (
            clean_provider(item.get("provider")) == DEFAULT_AGENT_PROVIDER
            and is_supported_provider_status(item.get("status"))
        ):
            return DEFAULT_AGENT_PROVIDER
    for item in providers:
        if is_supported_provider_status(item.get("status")):
            return clean_provider(item.get("provider"))
    for item in providers:
        provider = clean_provider(item.get("provider"))
        if provider:
            return provider
    return DEFAULT_AGENT_PROVIDER


def agent_composer_options_payload(provider, locale=None):
    args = ["agent", "composer-options", "--provider", provider]
    locale = normalize_locale(locale)
    if locale:
        args.extend(["--locale", locale])
    result = run_tutti_cli(args, timeout=30)
    effective_settings = (
        result.get("effectiveSettings")
        if isinstance(result.get("effectiveSettings"), dict)
        else {}
    )
    model_config = result.get("modelConfig") if isinstance(result.get("modelConfig"), dict) else {}
    reasoning_config = (
        result.get("reasoningConfig")
        if isinstance(result.get("reasoningConfig"), dict)
        else {}
    )
    models = normalize_config_options(model_config.get("options"))
    reasoning_levels = normalize_reasoning_options(reasoning_config.get("options"))
    current_model = clean_optional_string(effective_settings.get("model")) or config_option_selected_value(
        model_config
    )
    current_reasoning = clean_optional_string(
        effective_settings.get("reasoningEffort")
    ) or config_option_selected_value(reasoning_config)
    return {
        "models": [
            {
                **model,
                "defaultReasoningLevel": current_reasoning
                or (reasoning_levels[0]["effort"] if reasoning_levels else ""),
                "reasoningLevels": reasoning_levels,
            }
            for model in models
        ],
        "currentModel": current_model,
        "currentReasoningLevel": current_reasoning,
        "permissionMode": clean_optional_string(
            effective_settings.get("permissionModeId")
        ),
        "permissionConfig": normalize_permission_config(
            result.get("permissionConfig")
        ),
    }


def normalize_permission_config(value):
    if not isinstance(value, dict):
        return {"configurable": False, "modes": []}
    modes = []
    for mode in value.get("modes") or []:
        if not isinstance(mode, dict):
            continue
        mode_id = clean_optional_string(mode.get("id"))
        if not mode_id:
            continue
        modes.append(
            {
                "id": mode_id,
                "label": clean_first_string(mode, "label", "name"),
                "description": clean_first_string(mode, "description"),
                "semantic": clean_optional_string(mode.get("semantic")),
                "name": clean_optional_string(mode.get("name")),
                "defaultValue": clean_first_string(
                    mode, "defaultValue", "default_value", "default"
                ),
                "current": clean_first_string(
                    mode, "current", "currentValue", "current_value"
                ),
                "effective": clean_first_string(
                    mode, "effective", "effectiveValue", "effective_value"
                ),
            }
        )
    return {
        "configurable": bool(value.get("configurable")) and bool(modes),
        "defaultValue": clean_first_string(
            value, "defaultValue", "default_value", "default"
        ),
        "modes": modes,
    }


def config_option_selected_value(option):
    if not isinstance(option, dict):
        return ""
    return clean_first_string(
        option,
        "effective",
        "effectiveValue",
        "effective_value",
        "current",
        "currentValue",
        "current_value",
        "defaultValue",
        "default_value",
        "default",
    )


def normalize_config_options(options):
    result = []
    for option in options or []:
        if not isinstance(option, dict):
            continue
        value = clean_first_string(option, "value", "id", "model")
        if not value:
            continue
        label = clean_first_string(option, "label", "name", "displayName")
        result.append(
            {
                "id": value,
                "name": label or value,
                "label": label,
                "description": clean_first_string(option, "description"),
                "defaultValue": clean_first_string(
                    option, "defaultValue", "default_value", "default"
                ),
                "current": clean_first_string(
                    option, "current", "currentValue", "current_value"
                ),
                "effective": clean_first_string(
                    option, "effective", "effectiveValue", "effective_value"
                ),
            }
        )
    return result


def normalize_reasoning_options(options):
    result = []
    for option in options or []:
        if not isinstance(option, dict):
            continue
        value = clean_optional_string(option.get("value") or option.get("effort"))
        if not value:
            continue
        label = clean_first_string(option, "label", "name", "displayName")
        result.append(
            {
                "effort": value,
                "label": label,
                "description": clean_optional_string(
                    option.get("description")
                ),
                "defaultValue": clean_first_string(
                    option, "defaultValue", "default_value", "default"
                ),
                "current": clean_first_string(
                    option, "current", "currentValue", "current_value"
                ),
                "effective": clean_first_string(
                    option, "effective", "effectiveValue", "effective_value"
                ),
            }
        )
    return result


def cwd_options_payload():
    root = Path(WORKSPACE_ROOT or Path.home()).expanduser()
    options = []
    seen = set()

    def add(path, label, kind):
        try:
            resolved = path.expanduser().resolve()
        except Exception:
            resolved = path.expanduser()
        key = str(resolved)
        if key in seen or not resolved.is_dir():
            return
        seen.add(key)
        options.append({"path": key, "label": label, "kind": kind})

    add(root, root.name or str(root), "workspace")
    for worktree in git_worktrees(root):
        label = worktree.name or str(worktree)
        add(worktree, label, "worktree")
    for project in discover_project_dirs(root):
        label = relative_label(root, project)
        add(project, label, "project")

    return {"cwd": str(root), "directories": options}


def git_worktrees(root):
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "worktree", "list", "--porcelain"],
            check=True,
            capture_output=True,
            text=True,
            timeout=3,
        )
    except Exception:
        return []
    worktrees = []
    for line in result.stdout.splitlines():
        if line.startswith("worktree "):
            worktrees.append(Path(line.removeprefix("worktree ").strip()))
    return worktrees


def discover_project_dirs(root):
    if not root.is_dir():
        return []
    result = []
    ignored = {".git", ".cache", ".next", "node_modules", "dist", "build", "__pycache__"}
    def is_visible_project_candidate(entry):
        return entry.is_dir() and not entry.name.startswith(".") and entry.name not in ignored

    try:
        first_level = [entry for entry in root.iterdir() if is_visible_project_candidate(entry)]
    except Exception:
        return []
    candidates = list(first_level)
    for directory in first_level:
        try:
            candidates.extend(
                entry for entry in directory.iterdir() if is_visible_project_candidate(entry)
            )
        except Exception:
            continue
    for directory in candidates:
        if any((directory / marker).exists() for marker in PROJECT_MARKERS):
            result.append(directory)
    return sorted(result, key=lambda path: relative_label(root, path).lower())[:80]


def relative_label(root, path):
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


class Runner:
    def __init__(self, store):
        self.store = store
        self.queues = {}
        self.running_automations = set()
        self.cv = threading.Condition()
        self.processes = {}

    def enqueue(self, automation, trigger):
        active = self.store.has_active_run(automation["id"])
        concurrency = "queue" if trigger == "schedule" else automation["concurrency"]
        if active and concurrency == "skip":
            return None
        if active and concurrency == "replace":
            self.cancel(active)
        item_id = run_id()
        item = {
            "id": item_id,
            "automationId": automation["id"],
            "trigger": trigger,
            "runStatus": "queued",
            "prompt": automation["prompt"],
            "cwd": automation["cwd"],
            "queuedAt": now_iso(),
            "artifactDir": str(
                run_artifact_dir(automation["id"], item_id).resolve()
            ),
        }
        self.store.save_run(item)
        with self.cv:
            automation_queue = self.queues.setdefault(automation["id"], [])
            automation_queue.append((item["id"], automation))
            if automation["id"] not in self.running_automations:
                self.running_automations.add(automation["id"])
                threading.Thread(
                    target=self.loop_automation,
                    args=(automation["id"],),
                    daemon=True,
                ).start()
        return self.store.get_run(item["id"])

    def cancel(self, id_):
        with self.cv:
            for automation_id in list(self.queues):
                self.queues[automation_id] = [
                    (run_id_, aut)
                    for run_id_, aut in self.queues[automation_id]
                    if run_id_ != id_
                ]
                if not self.queues[automation_id]:
                    del self.queues[automation_id]
        run = self.store.get_run(id_)
        if not run:
            return None
        if run["runStatus"] == "queued":
            run["runStatus"] = "canceled"
            run["finishedAt"] = now_iso()
            run["error"] = "Canceled before start."
            return self.store.save_run(run)
        if run.get("agentSessionId"):
            run["runStatus"] = "canceling"
            self.store.save_run(run)
            try:
                cancel_agent_session(run["agentSessionId"])
            except Exception as exc:
                run["error"] = str(exc)
                self.store.save_run(run)
        return self.store.get_run(id_)

    def loop_automation(self, automation_id):
        while True:
            with self.cv:
                automation_queue = self.queues.get(automation_id) or []
                if not automation_queue:
                    self.queues.pop(automation_id, None)
                    self.running_automations.discard(automation_id)
                    return
                id_, automation = automation_queue.pop(0)
                if not automation_queue:
                    self.queues.pop(automation_id, None)
            self.run(id_, automation)

    def run(self, id_, automation):
        run = self.store.get_run(id_)
        if not run or run["runStatus"] != "queued":
            return
        artifact_dir = run_artifact_dir(automation["id"], id_)
        artifact_dir.mkdir(parents=True, exist_ok=True)
        log_path = artifact_dir / "run.log"
        run["runStatus"] = "running"
        run["startedAt"] = now_iso()
        run["artifactDir"] = str(artifact_dir)
        self.store.save_run(run)
        started = time.time()
        exit_code = None
        status = None
        error = None
        summary = None
        try:
            with log_path.open("ab") as log_file:
                session = start_agent_session(automation, run, log_file)
                agent_session_id = str(session.get("id") or "").strip()
                if not agent_session_id:
                    raise RuntimeError("agent session was not created")
                run["agentSessionId"] = agent_session_id
                run["agentProvider"] = str(session.get("provider") or "codex").strip() or "codex"
                self.store.save_run(run)
                while True:
                    latest = self.store.get_run(id_)
                    if latest and latest["runStatus"] == "canceling":
                        try:
                            cancel_agent_session(agent_session_id)
                        except Exception:
                            pass
                        status = "canceled"
                        error = "Canceled by user."
                        break
                    session = get_agent_session(agent_session_id, log_file=log_file)
                    status, error = terminal_agent_status(session.get("status"))
                    if status:
                        break
                    time.sleep(2)
                summary = latest_agent_summary(agent_session_id, log_file=log_file)
        except Exception as exc:
            status = "failed"
            error = str(exc)
        latest = self.store.get_run(id_)
        if latest and latest["runStatus"] == "canceling":
            status = "canceled"
            error = "Canceled by user."
        result_summary = summary
        result_status = latest.get("taskStatus") if latest else None
        if not result_status and status == "succeeded":
            status = "failed"
            error = "Automation did not submit a task status."
            result_status = "fail"
        if not result_status and status in {"failed", "timed_out"}:
            result_status = "fail"
        latest = latest or run
        latest.update(
            {
                "runStatus": status,
                "finishedAt": now_iso(),
                "exitCode": exit_code,
                "summary": result_summary,
                "error": error,
                "taskStatus": result_status,
                "artifactDir": str(artifact_dir),
            }
        )
        self.store.save_run(latest)
        print(f"run {id_} finished as {status} in {int(time.time() - started)}s", flush=True)


def terminate_process(process):
    try:
        if hasattr(os, "killpg"):
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        else:
            process.terminate()
        process.wait(timeout=8)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def read_text(path):
    try:
        return path.read_text(encoding="utf-8").strip() or None
    except FileNotFoundError:
        return None


def build_run_prompt(prompt, run):
    return (
        f"{prompt.rstrip()}\n\n---\n{automation_completion_instructions()}\n\n"
        f"Completion command template:\n{automation_completion_command(run)}\n"
    )


def automation_completion_instructions():
    return """
Automation completion contract:

1. Decide whether this automation result is "success", "fail", or "skip".
2. Submit the result status with the completion command shown below, replacing <status> with success, fail, or skip.
3. If the completion command fails, fix the problem and retry it before finishing.
4. After submitting the status successfully, send the user-facing result directly as your normal final Markdown response. Do not wrap the final response in JSON and do not write it to an intermediate file.

Use "skip" when there is nothing actionable to report.
""".strip()


def automation_completion_command(run):
    cli = shlex.quote(tutti_cli_command())
    run_id_value = shlex.quote(run["id"])
    return (
        f"{cli} automation complete-run --run-id {run_id_value} "
        f"--status <status>"
    )


def build_run_display_prompt(automation, run):
    return (
        clean_optional_string(run.get("prompt"))
        or clean_optional_string(automation.get("prompt"))
        or clean_optional_string(automation.get("name"))
        or "Run Automation"
    )


class Scheduler:
    def __init__(self, store, runner, autostart=True):
        self.store = store
        self.runner = runner
        self.cv = threading.Condition()
        self.thread = None
        if autostart:
            self.start()

    def start(self):
        if self.thread:
            return
        self.thread = threading.Thread(target=self.loop, daemon=True)
        self.thread.start()

    def wake(self):
        with self.cv:
            self.cv.notify_all()

    def loop(self):
        startup_scan = True
        while True:
            wait_seconds = None
            try:
                self.run_due_once(enqueue_due=not startup_scan)
                startup_scan = False
            except Exception as exc:
                print(f"scheduler error: {exc}", flush=True)
                wait_seconds = 5
            with self.cv:
                if wait_seconds is None:
                    wait_seconds = self.next_wait_seconds(datetime.now(timezone.utc))
                self.cv.wait(timeout=wait_seconds)

    def run_due_once(self, enqueue_due=True, now=None):
        now = now or datetime.now(timezone.utc)
        for automation in self.store.list_due_automations():
            if enqueue_due:
                self.runner.enqueue(automation, "schedule")
            automation["updatedAt"] = now_iso()
            automation["nextRunAt"] = compute_next_run(automation, now)
            self.store.save_automation(automation)

    def next_wait_seconds(self, now):
        next_run_at = self.store.next_scheduled_run_at()
        if next_run_at is None:
            return None
        return max(0, (next_run_at - now).total_seconds())


STORE = Store(DB_PATH)
RUNNER = Runner(STORE)
SCHEDULER = Scheduler(STORE, RUNNER)


def save_automation_and_wake(item):
    saved = STORE.save_automation(item)
    SCHEDULER.wake()
    return saved


def set_automation_enabled_and_wake(id_, enabled):
    item = STORE.set_automation_enabled(id_, enabled)
    if item:
        SCHEDULER.wake()
    return item


def delete_automation_and_wake(id_):
    deleted = STORE.delete_automation(id_)
    if deleted:
        SCHEDULER.wake()
    return deleted


def cli_input(payload):
    value = payload.get("input") if isinstance(payload, dict) else {}
    return value if isinstance(value, dict) else {}


def cli_table(columns, rows):
    return {"kind": "table", "columns": columns, "rows": rows}


def cli_json(value):
    return {"kind": "json", "value": value}


def cli_error(code, message):
    return {"error": {"code": code, "message": message}}


def automation_cli_columns():
    return [
        {"key": "id", "label": "ID"},
        {"key": "name", "label": "Name"},
        {"key": "enabled", "label": "Enabled"},
        {"key": "schedule", "label": "Schedule"},
        {"key": "next-run", "label": "Next run"},
        {"key": "active-run", "label": "Active run"},
        {"key": "unreviewed", "label": "Unreviewed"},
    ]


def automation_cli_rows(automations):
    return [
        {
            "id": item["id"],
            "name": item["name"],
            "enabled": "yes" if item["enabled"] else "no",
            "schedule": schedule_label(item),
            "next-run": item.get("nextRunAt") or "",
            "active-run": item.get("activeRunId") or "",
            "unreviewed": item.get("unreviewedRunCount") or 0,
        }
        for item in automations
    ]


def run_cli_columns():
    return [
        {"key": "id", "label": "ID"},
        {"key": "automation-id", "label": "Automation"},
        {"key": "run-status", "label": "Run status"},
        {"key": "task-status", "label": "Task status"},
        {"key": "trigger", "label": "Trigger"},
        {"key": "queued", "label": "Queued"},
        {"key": "finished", "label": "Finished"},
    ]


def run_cli_rows(runs):
    return [
        {
            "id": item["id"],
            "automation-id": item["automationId"],
            "run-status": item["runStatus"],
            "task-status": item.get("taskStatus") or "",
            "trigger": item["trigger"],
            "queued": item["queuedAt"],
            "finished": item.get("finishedAt") or "",
        }
        for item in runs
    ]


def complete_run_from_cli(input_):
    run_id_value = clean_required(input_.get("run-id"), "run-id")
    result_status = clean_required(input_.get("status"), "status").lower()
    if result_status not in RESULT_STATUS_VALUES:
        raise ValueError("status must be success, fail, or skip")
    run = STORE.complete_run(run_id_value, result_status)
    return run


def schedule_label(item):
    schedule_type = item.get("scheduleType") or "manual"
    schedule = item.get("schedule") if isinstance(item.get("schedule"), dict) else {}
    if schedule_type == "interval":
        return f"every {schedule.get('intervalMinutes', '')}m"
    if schedule_type == "daily":
        return f"daily {schedule.get('timeOfDay', '')}".strip()
    if schedule_type == "weekly":
        days = ",".join(str(day) for day in schedule.get("daysOfWeek", []))
        return f"weekly {days} {schedule.get('timeOfDay', '')}".strip()
    if schedule_type == "cron":
        return f"cron {schedule.get('expression', '')}".strip()
    return "manual"


def resolve_cli_automation(input_):
    automation_id_value = str(input_.get("automation-id") or "").strip()
    name = str(input_.get("name") or "").strip()
    if automation_id_value:
        automation = STORE.get_automation(automation_id_value)
        if not automation:
            raise ValueError(f"automation {automation_id_value} was not found")
        return automation
    if not name:
        raise ValueError("automation-id or name is required")
    matches = [
        item
        for item in STORE.list_automations()
        if item["name"].strip().lower() == name.lower()
    ]
    if not matches:
        raise ValueError(f"automation named {name} was not found")
    if len(matches) > 1:
        raise ValueError(f"automation name {name} matches multiple automations; pass automation-id")
    return matches[0]


def clean_cli_limit(value):
    if value in (None, ""):
        return 50
    return clean_int(value, 1, 200)


def cli_has(input_, key):
    return key in input_ and input_.get(key) is not None and str(input_.get(key)).strip() != ""


def clean_cli_automation_id(input_):
    automation_id_value = str(input_.get("automation-id") or "").strip()
    if not automation_id_value:
        raise ValueError("automation-id is required")
    return automation_id_value


def automation_payload_from_cli(input_, existing=None):
    payload = {}
    if existing:
        payload = {
            "name": existing["name"],
            "prompt": existing["prompt"],
            "cwd": existing["cwd"],
            "enabled": existing["enabled"],
            "scheduleType": existing["scheduleType"],
            "schedule": existing["schedule"],
            "concurrency": existing["concurrency"],
            "runnerSettings": existing.get("runnerSettings") or {},
            "runnerArgs": existing.get("runnerArgs") or [],
            "env": existing.get("env") or {},
        }
    for cli_key, payload_key in (
        ("name", "name"),
        ("prompt", "prompt"),
        ("cwd", "cwd"),
        ("enabled", "enabled"),
        ("concurrency", "concurrency"),
    ):
        if cli_key in input_:
            payload[payload_key] = input_[cli_key]
    payload["scheduleType"] = cli_schedule_type(input_, payload)
    payload["schedule"] = cli_schedule(input_, payload["scheduleType"], payload.get("schedule"))

    runner_settings = dict(payload.get("runnerSettings") or {})
    for cli_key, settings_key in (
        ("provider", "provider"),
        ("model", "model"),
        ("reasoning-effort", "reasoningEffort"),
        ("permission-mode", "permissionMode"),
    ):
        if cli_key in input_:
            runner_settings[settings_key] = input_[cli_key]
    if runner_settings:
        payload["runnerSettings"] = runner_settings
    if "runner-args" in input_:
        payload["runnerArgs"] = clean_cli_runner_args(input_.get("runner-args"))
    if "env" in input_:
        payload["env"] = clean_cli_env(input_.get("env"))
    return payload


def cli_schedule_type(input_, payload):
    if cli_has(input_, "schedule-type"):
        return str(input_.get("schedule-type")).strip()
    current = str(payload.get("scheduleType") or "").strip()
    if current:
        return current
    if cli_has(input_, "cron"):
        return "cron"
    if cli_has(input_, "interval-minutes"):
        return "interval"
    if cli_has(input_, "days-of-week"):
        return "weekly"
    if cli_has(input_, "time-of-day"):
        return "daily"
    return "manual"


def cli_schedule(input_, schedule_type, existing=None):
    schedule = dict(existing) if isinstance(existing, dict) else {}
    if "interval-minutes" in input_:
        schedule["intervalMinutes"] = input_["interval-minutes"]
    if "time-of-day" in input_:
        schedule["timeOfDay"] = input_["time-of-day"]
    if "days-of-week" in input_:
        schedule["daysOfWeek"] = clean_cli_days(input_.get("days-of-week"))
    if "cron" in input_:
        schedule["expression"] = input_["cron"]
    if schedule_type == "interval":
        return {"intervalMinutes": schedule.get("intervalMinutes", 60)}
    if schedule_type == "daily":
        return {"timeOfDay": schedule.get("timeOfDay", "09:00")}
    if schedule_type == "weekly":
        return {
            "timeOfDay": schedule.get("timeOfDay", "09:00"),
            "daysOfWeek": schedule.get("daysOfWeek", [1]),
        }
    if schedule_type == "cron":
        return {"expression": schedule.get("expression", "0 9 * * *")}
    return {}


def clean_cli_days(value):
    parts = [part.strip() for part in str(value or "").split(",")]
    days = [clean_int(part, 1, 7) for part in parts if part]
    return days or [1]


def clean_cli_runner_args(value):
    try:
        return [arg for arg in shlex.split(str(value or "")) if arg]
    except ValueError as exc:
        raise ValueError(f"runner-args is invalid: {exc}") from exc


def clean_cli_env(value):
    result = {}
    text = str(value or "").strip()
    if not text:
        return result
    for part in text.split(","):
        key, separator, val = part.partition("=")
        key = key.strip()
        if not key or not separator:
            raise ValueError("env must be comma-separated KEY=VALUE pairs")
        result[key] = val.strip()
    return result


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            path = urlparse(self.path).path
            query = parse_qs(urlparse(self.path).query)
            if path == "/healthz":
                return self.text(200, "ok")
            if path == "/":
                return self.file(PACKAGE_DIR / "static" / "index.html", "text/html; charset=utf-8")
            if path == "/assets/app.js":
                return self.file(PACKAGE_DIR / "static" / "app.js", "text/javascript; charset=utf-8")
            if path == "/assets/styles.css":
                return self.file(PACKAGE_DIR / "static" / "styles.css", "text/css; charset=utf-8")
            if path == "/assets/vendor/markdown-it.min.js":
                return self.file(
                    PACKAGE_DIR / "static" / "vendor" / "markdown-it.min.js",
                    "text/javascript; charset=utf-8",
                )
            if path == "/assets/vendor/purify.min.js":
                return self.file(
                    PACKAGE_DIR / "static" / "vendor" / "purify.min.js",
                    "text/javascript; charset=utf-8",
                )
            if path == "/assets/locales/en.json":
                return self.file(
                    PACKAGE_DIR / "static" / "locales" / "en.json",
                    "application/json; charset=utf-8",
                )
            if path == "/assets/locales/zh-CN.json":
                return self.file(
                    PACKAGE_DIR / "static" / "locales" / "zh-CN.json",
                    "application/json; charset=utf-8",
                )
            if path == "/assets/fonts/lexend-latin-wght-normal.woff2":
                return self.file(
                    PACKAGE_DIR / "static" / "fonts" / "lexend-latin-wght-normal.woff2",
                    "font/woff2",
                )
            if path == "/api/context":
                return self.json(200, context_payload())
            if path == "/api/agent-providers":
                return self.json(200, agent_providers_payload())
            if path == "/api/runner-options":
                return self.json(
                    200,
                    runner_options_payload(
                        query.get("provider", [None])[0],
                        query.get("locale", [None])[0],
                    ),
                )
            if path == "/api/cwd-options":
                return self.json(200, cwd_options_payload())
            if path == "/api/automations":
                return self.json(200, {"automations": STORE.list_automations()})
            if path.startswith("/api/automations/"):
                id_ = path.split("/", 3)[3]
                item = STORE.get_automation(id_)
                return self.json(200, {"automation": item}) if item else self.json(404, {"error": "automation not found"})
            if path == "/api/runs":
                runs = STORE.list_runs(query.get("automationId", [None])[0])
                return self.json(200, {"runs": runs})
            if path.startswith("/api/runs/") and path.endswith("/log"):
                id_ = path.split("/")[3]
                run = STORE.get_run(id_)
                if not run:
                    return self.json(404, {"error": "run not found"})
                return self.text(200, read_text(Path(run["artifactDir"]) / "run.log") or "")
            if path.startswith("/api/runs/"):
                id_ = path.split("/", 3)[3]
                run = STORE.get_run(id_)
                return self.json(200, {"run": run}) if run else self.json(404, {"error": "run not found"})
            if path == "/api/review":
                runs = [run for run in STORE.list_runs(limit=200) if run["finishedAt"] and not run["reviewedAt"]]
                return self.json(200, {"runs": runs})
            self.json(404, {"error": "not found"})
        except Exception as exc:
            self.json(500, {"error": str(exc)})

    def do_POST(self):
        self.handle_write("POST")

    def do_PUT(self):
        self.handle_write("PUT")

    def do_DELETE(self):
        self.handle_write("DELETE")

    def handle_write(self, method):
        try:
            path = urlparse(self.path).path
            if method == "POST" and path.startswith("/tutti/cli/"):
                return self.handle_cli(path)
            if method == "POST" and path == "/api/automations":
                item = normalize_automation(self.read_json())
                return self.json(201, {"automation": save_automation_and_wake(item)})
            if method == "POST" and path.startswith("/api/automations/") and path.endswith("/pause"):
                id_ = path.split("/")[3]
                item = set_automation_enabled_and_wake(id_, False)
                return self.json(200, {"automation": item}) if item else self.json(404, {"error": "automation not found"})
            if method == "POST" and path.startswith("/api/automations/") and path.endswith("/resume"):
                id_ = path.split("/")[3]
                item = set_automation_enabled_and_wake(id_, True)
                return self.json(200, {"automation": item}) if item else self.json(404, {"error": "automation not found"})
            if method == "PUT" and path.startswith("/api/automations/"):
                id_ = path.split("/", 3)[3]
                existing = STORE.get_automation(id_)
                if not existing:
                    return self.json(404, {"error": "automation not found"})
                return self.json(200, {"automation": save_automation_and_wake(normalize_automation(self.read_json(), existing))})
            if method == "DELETE" and path.startswith("/api/automations/"):
                deleted = delete_automation_and_wake(path.split("/", 3)[3])
                return self.json(200 if deleted else 404, {"deleted": deleted})
            if method == "POST" and path.startswith("/api/automations/") and path.endswith("/run"):
                id_ = path.split("/")[3]
                automation = STORE.get_automation(id_)
                if not automation:
                    return self.json(404, {"error": "automation not found"})
                run = RUNNER.enqueue(automation, "manual")
                return self.json(202, {"run": run})
            if method == "POST" and path.startswith("/api/runs/") and path.endswith("/cancel"):
                id_ = path.split("/")[3]
                run = RUNNER.cancel(id_)
                return self.json(200, {"run": run}) if run else self.json(404, {"error": "run not found"})
            if method == "POST" and path.startswith("/api/runs/") and path.endswith("/open-agent"):
                id_ = path.split("/")[3]
                run = STORE.get_run(id_)
                if not run:
                    return self.json(404, {"error": "run not found"})
                open_agent_session(run.get("agentSessionId"))
                return self.json(200, {"opened": True})
            if method == "POST" and path.startswith("/api/runs/") and path.endswith("/review"):
                id_ = path.split("/")[3]
                run = STORE.get_run(id_)
                if not run:
                    return self.json(404, {"error": "run not found"})
                run["reviewedAt"] = now_iso()
                return self.json(200, {"run": STORE.save_run(run)})
            self.json(404, {"error": "not found"})
        except ValueError as exc:
            if urlparse(self.path).path.startswith("/tutti/cli/"):
                return self.json(400, cli_error("invalid_input", str(exc)))
            self.json(400, {"error": str(exc)})
        except Exception as exc:
            if urlparse(self.path).path.startswith("/tutti/cli/"):
                return self.json(500, cli_error("handler_failed", str(exc)))
            self.json(500, {"error": str(exc)})

    def handle_cli(self, path):
        payload = self.read_json()
        input_ = cli_input(payload)
        if path == "/tutti/cli/list":
            automations = STORE.list_automations()
            return self.json(
                200,
                cli_table(automation_cli_columns(), automation_cli_rows(automations)),
            )
        if path == "/tutti/cli/get":
            automation = resolve_cli_automation(input_)
            return self.json(200, cli_json({"automation": automation}))
        if path == "/tutti/cli/create":
            item = normalize_automation(automation_payload_from_cli(input_))
            return self.json(
                200,
                cli_json({"automation": save_automation_and_wake(item)}),
            )
        if path == "/tutti/cli/update":
            automation_id_value = clean_cli_automation_id(input_)
            existing = STORE.get_automation(automation_id_value)
            if not existing:
                raise ValueError(f"automation {automation_id_value} was not found")
            item = normalize_automation(
                automation_payload_from_cli(input_, existing),
                existing,
            )
            return self.json(
                200,
                cli_json({"automation": save_automation_and_wake(item)}),
            )
        if path == "/tutti/cli/delete":
            automation_id_value = clean_cli_automation_id(input_)
            deleted = delete_automation_and_wake(automation_id_value)
            if not deleted:
                raise ValueError(f"automation {automation_id_value} was not found")
            return self.json(
                200,
                cli_json({"deleted": True, "automationId": automation_id_value}),
            )
        if path == "/tutti/cli/run":
            automation = resolve_cli_automation(input_)
            run = RUNNER.enqueue(automation, "manual")
            if not run:
                active_run_id = STORE.has_active_run(automation["id"])
                return self.json(
                    200,
                    cli_json(
                        {
                            "queued": False,
                            "automation": automation,
                            "activeRunId": active_run_id,
                            "message": "Automation already has an active run.",
                        }
                    ),
                )
            return self.json(
                200,
                cli_json({"queued": True, "automation": automation, "run": run}),
            )
        if path == "/tutti/cli/runs":
            automation_id_value = str(input_.get("automation-id") or "").strip() or None
            if automation_id_value and not STORE.get_automation(automation_id_value):
                raise ValueError(f"automation {automation_id_value} was not found")
            runs = STORE.list_runs(
                automation_id_value,
                limit=clean_cli_limit(input_.get("limit")),
            )
            return self.json(200, cli_table(run_cli_columns(), run_cli_rows(runs)))
        if path == "/tutti/cli/complete-run":
            run = complete_run_from_cli(input_)
            return self.json(200, cli_json({"completed": True, "run": run}))
        return self.json(404, cli_error("command_not_found", "command not found"))

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def json(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def text(self, status, body):
        body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def file(self, path, content_type):
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return


def context_payload():
    return {
        "workspaceId": WORKSPACE_ID,
        "workspaceName": WORKSPACE_NAME,
        "workspaceRoot": WORKSPACE_ROOT,
        "dataDir": str(DATA_DIR),
        "logDir": str(LOG_DIR),
        "runtimeDir": str(RUNTIME_DIR),
    }


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    host = os.environ.get("TUTTI_APP_HOST", "127.0.0.1")
    port = int(os.environ["TUTTI_APP_PORT"])
    print(f"Automation listening on {host}:{port}", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
