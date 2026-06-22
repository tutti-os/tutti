#!/usr/bin/env python3
"""Static validator for Tutti workspace app packages."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
from pathlib import Path
from typing import Any


BARE_RUNTIME_RE = re.compile(r"(^|[;&|`(]\s*|\s)(python3?|node|npm)(\s|$)")
URL_SETTING_RE = re.compile(
    r"(URLSearchParams|searchParams).*?(locale|lang|theme)|(locale|lang|theme).*?(URLSearchParams|searchParams)",
    re.IGNORECASE,
)


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


def flatten_keys(value: Any, prefix: str = "") -> set[str]:
    if isinstance(value, dict):
        keys: set[str] = set()
        for key, nested in value.items():
            next_prefix = f"{prefix}.{key}" if prefix else str(key)
            keys.update(flatten_keys(nested, next_prefix))
        return keys
    return {prefix}


def validate_manifest(root: Path, errors: list[str]) -> dict[str, Any] | None:
    manifest_path = root / "tutti.app.json"
    manifest = load_json(manifest_path, errors)
    if not isinstance(manifest, dict):
        errors.append("tutti.app.json must be a JSON object")
        return None

    if manifest.get("schemaVersion") != "tutti.app.manifest.v1":
        errors.append("tutti.app.json schemaVersion must be tutti.app.manifest.v1")
    for field in ("appId", "version", "name", "description"):
        if not isinstance(manifest.get(field), str) or not manifest.get(field):
            errors.append(f"tutti.app.json requires non-empty string field: {field}")

    icon = manifest.get("icon")
    if not isinstance(icon, dict) or icon.get("type") != "asset" or not is_safe_relative_path(icon.get("src")):
        errors.append("tutti.app.json icon must be an asset with a safe package-relative src")
    elif not (root / icon["src"]).is_file():
        errors.append(f"Manifest icon asset does not exist: {icon['src']}")

    runtime = manifest.get("runtime")
    if not isinstance(runtime, dict):
        errors.append("tutti.app.json requires runtime object")
    else:
        if "kind" in runtime:
            errors.append("runtime.kind is not supported; Tutti manages the runtime baseline")
        bootstrap = runtime.get("bootstrap")
        if not is_safe_relative_path(bootstrap):
            errors.append("runtime.bootstrap must be a safe package-relative path")
        elif not (root / bootstrap).is_file():
            errors.append(f"runtime.bootstrap file does not exist: {bootstrap}")
        healthcheck = runtime.get("healthcheckPath")
        if not isinstance(healthcheck, str) or not healthcheck.startswith("/"):
            errors.append("runtime.healthcheckPath must start with /")
        profile = runtime.get("profile")
        if profile is not None and profile != "node-static":
            errors.append("runtime.profile must be node-static when set")

    cli = manifest.get("cli")
    if cli is not None:
        if not isinstance(cli, dict) or not is_safe_relative_path(cli.get("manifest")):
            errors.append("cli.manifest must be a safe package-relative path")
        elif not (root / cli["manifest"]).is_file():
            errors.append(f"CLI manifest does not exist: {cli['manifest']}")

    references = manifest.get("references")
    if references is not None:
        endpoint = references.get("listEndpoint") if isinstance(references, dict) else None
        if not isinstance(endpoint, str) or not endpoint.startswith("/") or any(char in endpoint for char in "?#%"):
            errors.append("references.listEndpoint must be a relative URL path without query, hash, or percent encoding")

    localization = manifest.get("localizationInfo")
    if localization is not None:
        validate_localization_info(root, localization, errors)

    return manifest


def validate_localization_info(root: Path, localization: Any, errors: list[str]) -> None:
    if not isinstance(localization, dict):
        errors.append("localizationInfo must be an object")
        return
    if not isinstance(localization.get("defaultLocale"), str) or not localization.get("defaultLocale"):
        errors.append("localizationInfo.defaultLocale must be a non-empty string")
    locales = localization.get("additionalLocales")
    if not isinstance(locales, list):
        errors.append("localizationInfo.additionalLocales must be an array")
        return
    for entry in locales:
        if not isinstance(entry, dict):
            errors.append("Each localizationInfo.additionalLocales entry must be an object")
            continue
        locale = entry.get("locale")
        file_name = entry.get("file")
        if not isinstance(locale, str) or not locale:
            errors.append("Each additional locale needs a locale string")
        if not is_safe_relative_path(file_name):
            errors.append(f"Locale {locale or '<unknown>'} file must be package-relative")
            continue
        locale_path = root / file_name
        data = load_json(locale_path, errors)
        if isinstance(data, dict):
            for key in data:
                if key not in {"name", "description", "tags"}:
                    errors.append(f"{file_name} contains unsupported manifest localization key: {key}")


def validate_cli_manifest(root: Path, manifest: dict[str, Any], errors: list[str]) -> None:
    cli = manifest.get("cli")
    if not isinstance(cli, dict) or not is_safe_relative_path(cli.get("manifest")):
        return
    cli_manifest = load_json(root / cli["manifest"], errors)
    if not isinstance(cli_manifest, dict):
        errors.append("CLI manifest must be a JSON object")
        return
    if cli_manifest.get("schemaVersion") != "tutti.app.cli.v1":
        errors.append("CLI manifest schemaVersion must be tutti.app.cli.v1")
    commands = cli_manifest.get("commands")
    if not isinstance(commands, list):
        errors.append("CLI manifest commands must be an array")
        return
    for index, command in enumerate(commands):
        if not isinstance(command, dict):
            errors.append(f"CLI command {index} must be an object")
            continue
        handler = command.get("handler")
        if not isinstance(handler, dict):
            errors.append(f"CLI command {command.get('name', index)} requires a handler")
            continue
        if handler.get("kind") != "http" or handler.get("method") != "POST":
            errors.append(f"CLI command {command.get('name', index)} handler must be HTTP POST")
        path = handler.get("path")
        if not isinstance(path, str) or not path.startswith("/tutti/cli/"):
            errors.append(f"CLI command {command.get('name', index)} handler path must start with /tutti/cli/")


def validate_scripts(root: Path, manifest: dict[str, Any] | None, errors: list[str]) -> None:
    script_names = {"bootstrap.sh", "prepare.sh"}
    runtime = manifest.get("runtime") if isinstance(manifest, dict) else None
    if isinstance(runtime, dict) and isinstance(runtime.get("bootstrap"), str):
        script_names.add(runtime["bootstrap"])

    for name in script_names:
        path = root / name
        if not path.exists():
            if name == "bootstrap.sh":
                errors.append("Missing bootstrap.sh")
            continue
        mode = path.stat().st_mode
        if not mode & stat.S_IXUSR:
            errors.append(f"{name} must be executable")
        text = path.read_text(encoding="utf-8", errors="ignore")
        for line_number, line in enumerate(text.splitlines(), start=1):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if BARE_RUNTIME_RE.search(stripped) and "TUTTI_APP_" not in stripped:
                errors.append(f"{name}:{line_number} uses bare runtime command; use TUTTI_APP_* variables")
        if name == "bootstrap.sh" and re.search(r"\b(install|npm\s+i|npm\s+install|pip\s+install)\b", text):
            errors.append("bootstrap.sh should launch only; move install/build work to prepare.sh")


def validate_i18n_dictionaries(root: Path, errors: list[str]) -> None:
    locales_dir = root / "locales"
    if not locales_dir.is_dir():
        return

    by_file: dict[str, dict[str, set[str]]] = {}
    for locale_dir in sorted(path for path in locales_dir.iterdir() if path.is_dir()):
        for json_path in sorted(locale_dir.glob("*.json")):
            if json_path.name == "manifest.json":
                continue
            data = load_json(json_path, errors)
            if isinstance(data, dict):
                by_file.setdefault(json_path.name, {})[locale_dir.name] = flatten_keys(data)

    for file_name, locale_keys in by_file.items():
        if len(locale_keys) < 2:
            continue
        default_locale = "en" if "en" in locale_keys else sorted(locale_keys)[0]
        base = locale_keys[default_locale]
        for locale, keys in sorted(locale_keys.items()):
            missing = sorted(base - keys)
            extra = sorted(keys - base)
            if missing or extra:
                errors.append(
                    f"i18n key mismatch in {file_name} for {locale}: "
                    f"missing={','.join(missing) or '-'} extra={','.join(extra) or '-'}"
                )


def validate_no_url_settings(root: Path, errors: list[str]) -> None:
    for path in root.rglob("*"):
        if path.is_dir() or path.suffix.lower() not in {".js", ".jsx", ".ts", ".tsx", ".html"}:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if URL_SETTING_RE.search(text):
            errors.append(f"{path.relative_to(root)} appears to read locale/theme from URL search params")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package_root", nargs="?", default="package")
    args = parser.parse_args()

    root = Path(args.package_root).resolve()
    errors: list[str] = []
    if not root.is_dir():
        errors.append(f"Package root does not exist or is not a directory: {root}")
    else:
        manifest = validate_manifest(root, errors)
        if manifest:
            validate_cli_manifest(root, manifest, errors)
        validate_scripts(root, manifest, errors)
        validate_i18n_dictionaries(root, errors)
        validate_no_url_settings(root, errors)

    if errors:
        print("Tutti app package validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("Tutti app package validation passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
