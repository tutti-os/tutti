import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseJSONObject } from "./normalizer.ts";

export function loadClaudeSettingsEnv(
  configDir: string
): Record<string, string> {
  return claudeSettingsEnvFromFile(join(configDir, "settings.json"));
}

/**
 * Mirrors Claude CLI settings layering: user settings first, then project
 * settings from the filesystem root to cwd, with settings.local.json taking
 * precedence over settings.json in each directory.
 */
export function claudeSettingsEnv(cwd: string): Record<string, string> {
  const configDir = process.env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`;
  const merged = loadClaudeSettingsEnv(configDir);
  for (const path of claudeProjectSettingsPaths(cwd)) {
    Object.assign(merged, claudeSettingsEnvFromFile(path));
  }
  return merged;
}

function claudeProjectSettingsPaths(cwd: string): string[] {
  const trimmed = cwd.trim();
  if (!trimmed) {
    return [];
  }
  const directories: string[] = [];
  let current = resolve(trimmed);
  for (;;) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  directories.reverse();
  return directories.flatMap((directory) => [
    join(directory, ".claude", "settings.json"),
    join(directory, ".claude", "settings.local.json")
  ]);
}

function claudeSettingsEnvFromFile(path: string): Record<string, string> {
  try {
    const parsed = parseJSONObject(readFileSync(path, "utf8"));
    if (
      !parsed?.env ||
      typeof parsed.env !== "object" ||
      Array.isArray(parsed.env)
    ) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
  } catch {
    return {};
  }
}
