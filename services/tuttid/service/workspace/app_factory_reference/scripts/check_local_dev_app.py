#!/usr/bin/env python3
"""Static checker for Tutti Load unpacked local debug apps."""

from __future__ import annotations

import argparse
import json
import re
import stat
import sys
from pathlib import Path
from typing import Any


CLI_TIMEOUT_MIN_MS = 1000
CLI_TIMEOUT_MAX_MS = 600000

BARE_RUNTIME_RE = re.compile(
    r"(^|[;&|`(]\s*|\s)(python3?|node|npm|pnpm|yarn)(\s|$)"
)
HARDCODED_PORT_ARG_RE = re.compile(r"\b(?:-p|--port)\s+['\"]?\d{2,5}['\"]?")
HARDCODED_PORT_ASSIGNMENT_RE = re.compile(
    r"\b(?:PORT|port)\s*=\s*['\"]?\d{2,5}['\"]?"
)
PORT_FALLBACK_RE = re.compile(r"TUTTI_APP_PORT:?-\d{2,5}")
PORT_REQUIRED_RE = re.compile(
    r"\$\{TUTTI_APP_PORT:\?"
    r"|(?:test|\[)\s+-z\s+['\"]?\$\{?TUTTI_APP_PORT"
)
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def load_json(path: Path, errors: list[str]) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        errors.append(f"Missing file: {path}")
    except json.JSONDecodeError as exc:
        errors.append(f"Invalid JSON in {path}: {exc}")
    return None


def is_safe_relative_path(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    path = Path(value)
    if path.is_absolute():
        return False
    if "://" in value or "\x00" in value:
        return False
    return ".." not in path.parts


def resolve_dev_app_dir(source_dir: Path, errors: list[str]) -> Path | None:
    if not source_dir.is_dir():
        errors.append(f"Source directory does not exist: {source_dir}")
        return None

    exact_manifest = source_dir / "tutti.app.json"
    if exact_manifest.is_file():
        return source_dir

    nested_dev_app = source_dir / ".tutti" / "dev-app"
    nested_manifest = nested_dev_app / "tutti.app.json"
    if nested_manifest.is_file():
        return nested_dev_app

    errors.append(
        "No local debug app manifest found. Expected tutti.app.json in the "
        "selected directory or .tutti/dev-app/tutti.app.json under the project root."
    )
    return None


def validate_manifest(dev_app_dir: Path, errors: list[str]) -> dict[str, Any] | None:
    manifest = load_json(dev_app_dir / "tutti.app.json", errors)
    if not isinstance(manifest, dict):
        errors.append("tutti.app.json must be a JSON object")
        return None

    if manifest.get("schemaVersion") != "tutti.app.manifest.v1":
        errors.append("tutti.app.json schemaVersion must be tutti.app.manifest.v1")
    for field in ("appId", "version", "name", "description"):
        if not isinstance(manifest.get(field), str) or not manifest.get(field):
            errors.append(f"tutti.app.json requires non-empty string field: {field}")

    icon = manifest.get("icon")
    if icon is not None:
        if (
            not isinstance(icon, dict)
            or icon.get("type") != "asset"
            or not is_safe_relative_path(icon.get("src"))
        ):
            errors.append("tutti.app.json icon must be an asset with a safe dev-app-relative src")
        elif not (dev_app_dir / icon["src"]).is_file():
            errors.append(f"Manifest icon asset does not exist: {icon['src']}")

    runtime = manifest.get("runtime")
    if not isinstance(runtime, dict):
        errors.append("tutti.app.json requires runtime object")
    else:
        if "kind" in runtime:
            errors.append("runtime.kind is not supported; Tutti manages the runtime baseline")
        bootstrap = runtime.get("bootstrap")
        if not is_safe_relative_path(bootstrap):
            errors.append("runtime.bootstrap must be a safe dev-app-relative path")
        elif not (dev_app_dir / bootstrap).is_file():
            errors.append(f"runtime.bootstrap file does not exist: {bootstrap}")
        healthcheck = runtime.get("healthcheckPath")
        if not isinstance(healthcheck, str) or not healthcheck.startswith("/"):
            errors.append("runtime.healthcheckPath must start with /")
        profile = runtime.get("profile")
        if profile is not None and profile not in {"node-static", "standalone"}:
            errors.append("runtime.profile must be node-static or standalone when set")

    cli = manifest.get("cli")
    if cli is not None:
        if not isinstance(cli, dict) or not is_safe_relative_path(cli.get("manifest")):
            errors.append("cli.manifest must be a safe dev-app-relative path")
        elif not (dev_app_dir / cli["manifest"]).is_file():
            errors.append(f"CLI manifest does not exist: {cli['manifest']}")

    return manifest


def validate_bootstrap(
    dev_app_dir: Path,
    manifest: dict[str, Any] | None,
    errors: list[str],
) -> None:
    script_names = {"bootstrap.sh"}
    runtime = manifest.get("runtime") if isinstance(manifest, dict) else None
    if isinstance(runtime, dict) and isinstance(runtime.get("bootstrap"), str):
        script_names.add(runtime["bootstrap"])

    for script_name in sorted(script_names):
        script_path = dev_app_dir / script_name
        if not script_path.is_file():
            errors.append(f"Missing bootstrap script: {script_name}")
            continue
        mode = script_path.stat().st_mode
        if not mode & stat.S_IXUSR:
            errors.append(f"{script_name} must be executable")
        text = script_path.read_text(encoding="utf-8", errors="ignore")
        active_lines = [
            (line_number, line.strip())
            for line_number, line in enumerate(text.splitlines(), start=1)
            if line.strip() and not line.strip().startswith("#")
        ]
        active_text = "\n".join(stripped for _, stripped in active_lines)
        if "TUTTI_APP_PORT" not in active_text:
            errors.append(f"{script_name} must read TUTTI_APP_PORT")
        elif not PORT_REQUIRED_RE.search(active_text) or PORT_FALLBACK_RE.search(active_text):
            errors.append(
                f"{script_name} must fail when TUTTI_APP_PORT is absent; "
                "do not use a fallback port"
            )
        if "TUTTI_APP_HOST" not in active_text:
            errors.append(f"{script_name} must read TUTTI_APP_HOST")
        if (
            HARDCODED_PORT_ARG_RE.search(active_text)
            or HARDCODED_PORT_ASSIGNMENT_RE.search(active_text)
        ):
            errors.append(
                f"{script_name} appears to hard-code a port; "
                "pass TUTTI_APP_PORT to the dev server"
            )

        for line_number, stripped in active_lines:
            if BARE_RUNTIME_RE.search(stripped) and "TUTTI_APP_" not in stripped:
                errors.append(
                    f"{script_name}:{line_number} uses a bare runtime command; "
                    "prefer TUTTI_APP_NODE, TUTTI_APP_NPM, or TUTTI_APP_PYTHON"
                )


def validate_cli_manifest(
    dev_app_dir: Path,
    manifest: dict[str, Any] | None,
    errors: list[str],
) -> None:
    cli_manifest_path: Path | None = None
    cli = manifest.get("cli") if isinstance(manifest, dict) else None
    if isinstance(cli, dict) and is_safe_relative_path(cli.get("manifest")):
        cli_manifest_path = dev_app_dir / cli["manifest"]
    elif (dev_app_dir / "tutti.cli.json").is_file():
        cli_manifest_path = dev_app_dir / "tutti.cli.json"

    if cli_manifest_path is None:
        return

    cli_manifest = load_json(cli_manifest_path, errors)
    if not isinstance(cli_manifest, dict):
        errors.append("CLI manifest must be a JSON object")
        return
    if cli_manifest.get("schemaVersion") != "tutti.app.cli.v1":
        errors.append("CLI manifest schemaVersion must be tutti.app.cli.v1")
    scope = cli_manifest.get("scope")
    if not isinstance(scope, str) or not SLUG_RE.match(scope):
        errors.append("CLI manifest scope must use lowercase letters, numbers, and hyphen")
    commands = cli_manifest.get("commands")
    if not isinstance(commands, list):
        errors.append("CLI manifest commands must be an array")
        return
    for index, command in enumerate(commands):
        if not isinstance(command, dict):
            errors.append(f"CLI manifest commands[{index}] must be an object")
            continue
        path = command.get("path")
        if (
            not isinstance(path, list)
            or not path
            or any(
                not isinstance(part, str) or not SLUG_RE.match(part)
                for part in path
            )
        ):
            errors.append(f"CLI manifest commands[{index}].path must be non-empty lowercase path segments")
        handler = command.get("handler")
        if not isinstance(handler, dict):
            errors.append(f"CLI manifest commands[{index}] requires a handler")
            continue
        if "url" in handler:
            errors.append(f"CLI manifest commands[{index}].handler must not declare a full URL")
        if handler.get("kind") != "http":
            errors.append(f"CLI manifest commands[{index}].handler.kind must be http")
        if handler.get("method") != "POST":
            errors.append(f"CLI manifest commands[{index}].handler.method must be POST")
        handler_path = handler.get("path")
        if not isinstance(handler_path, str) or not handler_path.startswith("/tutti/cli/"):
            errors.append(f"CLI manifest commands[{index}].handler.path must start with /tutti/cli/")
        timeout_ms = handler.get("timeoutMs")
        if timeout_ms is not None:
            if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int):
                errors.append(f"CLI manifest commands[{index}].handler.timeoutMs must be an integer")
            elif timeout_ms < CLI_TIMEOUT_MIN_MS or timeout_ms > CLI_TIMEOUT_MAX_MS:
                errors.append(
                    f"CLI manifest commands[{index}].handler.timeoutMs must be between "
                    f"{CLI_TIMEOUT_MIN_MS} and {CLI_TIMEOUT_MAX_MS}"
                )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "source_dir",
        nargs="?",
        default=".",
        help="Project root or .tutti/dev-app directory to check",
    )
    args = parser.parse_args()

    source_dir = Path(args.source_dir).expanduser().resolve()
    errors: list[str] = []
    dev_app_dir = resolve_dev_app_dir(source_dir, errors)
    if dev_app_dir is not None:
        manifest = validate_manifest(dev_app_dir, errors)
        validate_bootstrap(dev_app_dir, manifest, errors)
        validate_cli_manifest(dev_app_dir, manifest, errors)

    if errors:
        print("Tutti local debug app check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print(f"Tutti local debug app check passed: {dev_app_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
