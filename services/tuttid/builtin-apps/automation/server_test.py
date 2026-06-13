import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


def load_server_module(temp_root):
    package_dir = Path(__file__).resolve().parent
    os.environ["TUTTI_APP_PACKAGE_DIR"] = str(package_dir)
    os.environ["TUTTI_APP_DATA_DIR"] = str(temp_root / "data")
    os.environ["TUTTI_APP_LOG_DIR"] = str(temp_root / "logs")
    os.environ["TUTTI_APP_RUNTIME_DIR"] = str(temp_root / "runtime")
    os.environ["TUTTI_WORKSPACE_ID"] = "workspace-1"
    os.environ["TUTTI_APP_PORT"] = "0"
    os.environ["TUTTI_CLI"] = "/usr/local/bin/tutti"

    spec = importlib.util.spec_from_file_location(
        f"automation_server_test_{id(temp_root)}",
        package_dir / "server.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RunnerOptionsPayloadTest(unittest.TestCase):
    def test_runner_options_uses_cli_locale_and_structured_configs(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            calls = []

            def fake_run_tutti_cli(args, timeout=30, log_file=None):
                calls.append(args)
                if args == ["agent", "providers"]:
                    return {
                        "defaultProvider": "codex",
                        "providers": [
                            {"provider": "codex", "status": "ready"},
                            {"provider": "claude-code", "status": "ready"},
                        ],
                    }
                if args == [
                    "agent",
                    "composer-options",
                    "--provider",
                    "codex",
                    "--locale",
                    "zh-CN",
                ]:
                    return {
                        "effectiveSettings": {
                            "model": "gpt-5",
                            "permissionModeId": "full-access",
                            "reasoningEffort": "high",
                        },
                        "modelConfig": {
                            "currentValue": "gpt-5",
                            "options": [
                                {
                                    "id": "gpt-5",
                                    "label": "GPT-5",
                                    "value": "gpt-5",
                                }
                            ],
                        },
                        "reasoningConfig": {
                            "currentValue": "high",
                            "options": [
                                {
                                    "id": "high",
                                    "label": "高",
                                    "value": "high",
                                }
                            ],
                        },
                        "permissionConfig": {
                            "configurable": True,
                            "defaultValue": "auto",
                            "modes": [
                                {
                                    "id": "auto",
                                    "label": "代我批准",
                                    "semantic": "auto",
                                },
                                {
                                    "id": "full-access",
                                    "label": "完全访问",
                                    "semantic": "full-access",
                                },
                            ],
                        },
                        "runtimeContext": {
                            "configOptions": [
                                {
                                    "id": "model",
                                    "currentValue": "legacy-model",
                                }
                            ]
                        },
                    }
                raise AssertionError(f"unexpected CLI args: {args!r}")

            with mock.patch.object(module, "run_tutti_cli", fake_run_tutti_cli):
                payload = module.runner_options_payload(provider="codex", locale="zh-CN")

            self.assertEqual(
                calls[1],
                [
                    "agent",
                    "composer-options",
                    "--provider",
                    "codex",
                    "--locale",
                    "zh-CN",
                ],
            )
            self.assertEqual(payload["defaultProvider"], "codex")
            self.assertEqual(payload["provider"], "codex")
            self.assertEqual(payload["currentModel"], "gpt-5")
            self.assertEqual(payload["currentReasoningLevel"], "high")
            self.assertEqual(payload["permissionMode"], "full-access")
            self.assertEqual(payload["models"][0]["label"], "GPT-5")
            self.assertEqual(payload["models"][0]["reasoningLevels"][0]["label"], "高")
            self.assertEqual(
                payload["permissionConfig"]["modes"][0]["label"],
                "代我批准",
            )


class AgentSessionLaunchTest(unittest.TestCase):
    def test_manual_run_requests_agent_gui_activation(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            calls = []

            def fake_run_tutti_cli(args, timeout=30, log_file=None):
                calls.append(args)
                return {"session": {"id": "agent-session-1", "provider": "codex"}}

            automation = {
                "name": "Review",
                "prompt": "Review the workspace.",
                "runnerSettings": {"provider": "codex"},
                "runnerArgs": [],
            }
            run = {
                "id": "run_123",
                "trigger": "manual",
                "prompt": "Review the workspace.",
                "cwd": str(Path.cwd()),
                "artifactDir": str(Path(temp_dir) / "artifacts"),
            }

            with mock.patch.object(module, "run_tutti_cli", fake_run_tutti_cli):
                session = module.start_agent_session(automation, run, log_file=None)

            self.assertEqual(session["id"], "agent-session-1")
            self.assertIn("--show", calls[0])
            self.assertNotIn("--visible", calls[0])

    def test_scheduled_run_stays_visible_without_activating_agent_gui(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            calls = []

            def fake_run_tutti_cli(args, timeout=30, log_file=None):
                calls.append(args)
                return {"session": {"id": "agent-session-1", "provider": "codex"}}

            automation = {
                "name": "Review",
                "prompt": "Review the workspace.",
                "runnerSettings": {"provider": "codex"},
                "runnerArgs": [],
            }
            run = {
                "id": "run_123",
                "trigger": "schedule",
                "prompt": "Review the workspace.",
                "cwd": str(Path.cwd()),
                "artifactDir": str(Path(temp_dir) / "artifacts"),
            }

            with mock.patch.object(module, "run_tutti_cli", fake_run_tutti_cli):
                session = module.start_agent_session(automation, run, log_file=None)

            self.assertEqual(session["id"], "agent-session-1")
            self.assertIn("--visible", calls[0])
            self.assertNotIn("--show", calls[0])


class SchedulerTest(unittest.TestCase):
    def test_scheduler_waits_until_next_scheduled_run(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            now = module.datetime(2026, 1, 1, 3, 0, 0, tzinfo=module.timezone.utc)
            store = FakeSchedulerStore(now + module.timedelta(seconds=2.5))
            scheduler = module.Scheduler(store, FakeRunner(), autostart=False)

            self.assertEqual(scheduler.next_wait_seconds(now), 2.5)

    def test_scheduler_waits_without_timeout_when_no_scheduled_run(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            now = module.datetime(2026, 1, 1, 3, 0, 0, tzinfo=module.timezone.utc)
            scheduler = module.Scheduler(FakeSchedulerStore(None), FakeRunner(), autostart=False)

            self.assertIsNone(scheduler.next_wait_seconds(now))

    def test_startup_due_scan_advances_without_enqueueing(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            now = module.datetime(2026, 1, 1, 3, 0, 0, tzinfo=module.timezone.utc)
            automation = fake_interval_automation(module, now - module.timedelta(minutes=30))
            store = FakeSchedulerStore(None, due_automations=[automation])
            runner = FakeRunner()
            scheduler = module.Scheduler(store, runner, autostart=False)

            scheduler.run_due_once(enqueue_due=False, now=now)

            self.assertEqual(runner.enqueued, [])
            self.assertEqual(len(store.saved), 1)
            self.assertEqual(
                store.saved[0]["nextRunAt"],
                (now + module.timedelta(minutes=15)).isoformat(),
            )

    def test_regular_due_scan_enqueues_scheduled_run(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            now = module.datetime(2026, 1, 1, 3, 0, 0, tzinfo=module.timezone.utc)
            automation = fake_interval_automation(module, now)
            store = FakeSchedulerStore(None, due_automations=[automation])
            runner = FakeRunner()
            scheduler = module.Scheduler(store, runner, autostart=False)

            scheduler.run_due_once(now=now)

            self.assertEqual(runner.enqueued, [("aut_1", "schedule")])
            self.assertEqual(len(store.saved), 1)


class FakeSchedulerStore:
    def __init__(self, next_run_at, due_automations=None):
        self.next_run_at = next_run_at
        self.due_automations = due_automations or []
        self.saved = []

    def list_due_automations(self):
        return [dict(automation) for automation in self.due_automations]

    def next_scheduled_run_at(self):
        return self.next_run_at

    def save_automation(self, automation):
        self.saved.append(dict(automation))
        return automation


class FakeRunner:
    def __init__(self):
        self.enqueued = []

    def enqueue(self, automation, trigger):
        self.enqueued.append((automation["id"], trigger))
        return {"id": "run_1"}


def fake_interval_automation(module, next_run_at):
    return {
        "id": "aut_1",
        "enabled": True,
        "scheduleType": "interval",
        "schedule": {"intervalMinutes": 15},
        "nextRunAt": next_run_at.isoformat(),
    }


class RunCompletionTest(unittest.TestCase):
    def test_ready_agent_status_finishes_automation_run(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            self.assertEqual(module.terminal_agent_status("ready"), ("succeeded", None))
            self.assertEqual(module.terminal_agent_status("created"), ("succeeded", None))
            self.assertEqual(module.terminal_agent_status("idle"), ("succeeded", None))

    def test_complete_run_updates_running_run_task_status(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            run = make_running_run(module)

            completed = module.complete_run_from_cli(
                {
                    "run-id": run["id"],
                    "status": "fail",
                }
            )

            self.assertEqual(completed["runStatus"], "running")
            self.assertEqual(completed["taskStatus"], "fail")
            self.assertIsNone(completed["summary"])
            self.assertIsNone(completed["error"])
            self.assertIsNone(completed["finishedAt"])
            self.assertNotIn("status", completed)
            self.assertNotIn("resultStatus", completed)
            self.assertNotIn("completionToken", completed)

    def test_complete_run_rejects_non_running_run(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            run = make_running_run(module)
            run["runStatus"] = "succeeded"
            run["finishedAt"] = module.now_iso()
            module.STORE.save_run(run)

            with self.assertRaisesRegex(ValueError, "run is not accepting completion"):
                module.complete_run_from_cli(
                    {
                        "run-id": run["id"],
                        "status": "success",
                    }
                )

            stored = module.STORE.get_run(run["id"])
            self.assertEqual(stored["runStatus"], "succeeded")
            self.assertIsNone(stored["taskStatus"])

    def test_final_run_save_does_not_overwrite_submitted_task_status(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            run = make_running_run(module)
            run["agentSessionId"] = "agent-session-1"
            module.STORE.save_run(run)

            module.complete_run_from_cli(
                {
                    "run-id": run["id"],
                    "status": "success",
                }
            )
            run["runStatus"] = "succeeded"
            run["finishedAt"] = module.now_iso()
            run["summary"] = "Done"
            run["taskStatus"] = "fail"
            saved = module.STORE.save_run(run)

            self.assertEqual(saved["runStatus"], "succeeded")
            self.assertEqual(saved["taskStatus"], "success")
            self.assertEqual(saved["summary"], "Done")

    def test_runner_fails_succeeded_session_without_submitted_task_status(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            run = make_run(module, "queued")
            automation = module.STORE.get_automation(run["automationId"])

            with (
                mock.patch.object(
                    module,
                    "start_agent_session",
                    return_value={"id": "agent-session-1", "provider": "codex"},
                ),
                mock.patch.object(module, "get_agent_session", return_value={"status": "ready"}),
                mock.patch.object(
                    module,
                    "agent_session_messages",
                    return_value=[
                        {
                            "role": "assistant",
                            "version": 1,
                            "payload": {"text": "Finished normally."},
                        }
                    ],
                ),
            ):
                module.Runner(module.STORE).run(run["id"], automation)

            stored = module.STORE.get_run(run["id"])
            self.assertEqual(stored["runStatus"], "failed")
            self.assertEqual(stored["taskStatus"], "fail")
            self.assertEqual(stored["summary"], "Finished normally.")
            self.assertEqual(
                stored["error"],
                "Automation did not submit a task status.",
            )

    def test_run_prompt_instructs_markdown_final_response_and_completion_command(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            run = {
                "id": "run_123",
                "artifactDir": str(Path(temp_dir) / "artifacts"),
            }

            prompt = module.build_run_prompt("Review the repository.", run)

            self.assertIn("automation complete-run", prompt)
            self.assertIn("--run-id run_123", prompt)
            self.assertNotIn("--token", prompt)
            self.assertIn("--status <status>", prompt)
            self.assertIn("send the user-facing result directly", prompt)
            self.assertIn("Do not wrap the final response in JSON", prompt)
            self.assertIn("do not write it to an intermediate file", prompt)
            self.assertNotIn("summary-file", prompt)


def make_running_run(module):
    return make_run(module, "running")


def make_run(module, run_status):
    automation = module.STORE.save_automation(
        module.normalize_automation(
            {
                "name": "Test automation",
                "prompt": "Review",
                "cwd": str(Path.cwd()),
                "enabled": False,
                "scheduleType": "manual",
                "schedule": {},
                "concurrency": "queue",
                "runnerSettings": {},
                "runnerArgs": [],
                "env": {},
            }
        )
    )
    return module.STORE.save_run(
        {
            "id": "run_123",
            "automationId": automation["id"],
            "trigger": "manual",
            "runStatus": run_status,
            "prompt": "Review",
            "cwd": str(Path.cwd()),
            "queuedAt": module.now_iso(),
            "startedAt": module.now_iso() if run_status != "queued" else None,
            "artifactDir": str(Path(module.LOG_DIR) / "runs" / automation["id"] / "run_123"),
        }
    )


if __name__ == "__main__":
    unittest.main()
