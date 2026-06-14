#!/usr/bin/env node
// Patches the globally-installed @agentclientprotocol/claude-agent-acp bridge to
// expose an orthogonal "fast" config option backed by the Claude Agent SDK's
// `Settings.fastMode` (via `query.applyFlagSettings({ fastMode })`) — the same
// flag-layer path the bridge already uses for `effortLevel`.
//
// Why a codemod and not a unified diff: the bridge ships only a bundled
// `dist/acp-agent.js` and is provisioned via `npm install -g` (see
// services/tuttid/service/agentstatus/registry.go), so there is no source tree
// to patch. The string anchors below are stable across 0.42.x–0.44.x. The
// script is idempotent (skips if a `fast` option is already present).
//
// Applied automatically after the bridge installs (InstallerPostStep in
// installer.go embeds this file). Run manually after installing/upgrading the
// bridge with:  pnpm patch:claude-agent-acp
// Override the target with --dist <path> or CLAUDE_AGENT_ACP_DIST.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RELATIVE_DIST = join(
  "@agentclientprotocol",
  "claude-agent-acp",
  "dist",
  "acp-agent.js"
);

function resolveDistPath() {
  const flagIndex = process.argv.indexOf("--dist");
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) {
    return process.argv[flagIndex + 1];
  }
  if (process.env.CLAUDE_AGENT_ACP_DIST) {
    return process.env.CLAUDE_AGENT_ACP_DIST;
  }
  const candidates = [];
  try {
    const root = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8"
    }).trim();
    if (root) {
      candidates.push(join(root, RELATIVE_DIST));
    }
  } catch {
    // npm not on PATH; fall back to known locations below.
  }
  candidates.push(join("/opt/homebrew/lib/node_modules", RELATIVE_DIST));
  candidates.push(join("/usr/local/lib/node_modules", RELATIVE_DIST));
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

const EDITS = [
  {
    name: "buildConfigOptions signature",
    find: "function buildConfigOptions(modes, models, modelInfos, currentEffortLevel) {",
    replace:
      "function buildConfigOptions(modes, models, modelInfos, currentEffortLevel, currentFastMode) {"
  },
  {
    name: "advertise fast config option",
    find: "    return options;\n}\n// Claude Code CLI persists display strings",
    replace: `    // tutti patch: orthogonal fast/speed dimension backed by SDK fastMode.
    options.push({
        id: "fast",
        name: "Fast",
        description: "Fast mode (Opus, faster output, increased usage)",
        category: "speed",
        type: "select",
        currentValue: currentFastMode === true || currentFastMode === "fast" || currentFastMode === "on" ? "fast" : "standard",
        options: [
            { value: "standard", name: "Standard" },
            { value: "fast", name: "Fast" },
        ],
    });
    return options;
}
// Claude Code CLI persists display strings`
  },
  {
    name: "seed fast at session creation",
    find: "const configOptions = buildConfigOptions(modes, models, allowedModels, settingsManager.getSettings().effortLevel);",
    replace:
      "const configOptions = buildConfigOptions(modes, models, allowedModels, settingsManager.getSettings().effortLevel, settingsManager.getSettings().fastMode === true);"
  },
  {
    name: "apply initial fast mode to the SDK",
    find: "        this.sessions[sessionId] = {",
    replace: `        // tutti patch: apply the initial fast mode so the SDK matches the UI.
        const initialFast = configOptions.find((o) => o.id === "fast");
        if (initialFast && initialFast.currentValue === "fast") {
            await q.applyFlagSettings({ fastMode: true });
        }
        this.sessions[sessionId] = {`
  },
  {
    name: "preserve fast across model switch rebuild",
    find: "session.configOptions = buildConfigOptions(session.modes, session.models, session.modelInfos, currentEffort);",
    replace:
      'session.configOptions = buildConfigOptions(session.modes, session.models, session.modelInfos, currentEffort, session.configOptions.find((o) => o.id === "fast")?.currentValue === "fast");'
  },
  {
    name: "route fast config option to applyFlagSettings",
    find: `            if (configId === "effort") {
                await session.query.applyFlagSettings({
                    effortLevel: toSdkEffortLevel(value),
                });
            }`,
    replace: `            if (configId === "effort") {
                await session.query.applyFlagSettings({
                    effortLevel: toSdkEffortLevel(value),
                });
            }
            else if (configId === "fast") {
                await session.query.applyFlagSettings({ fastMode: value === "fast" });
            }`
  }
];

const distPath = resolveDistPath();
if (!existsSync(distPath)) {
  console.error(`claude-agent-acp bundle not found at: ${distPath}`);
  console.error(
    "Install it first (npm install -g @agentclientprotocol/claude-agent-acp) or pass --dist <path>."
  );
  process.exit(1);
}

let source = readFileSync(distPath, "utf8");
if (/id:\s*"fast"/.test(source)) {
  console.log(`Already patched (fast config option present): ${distPath}`);
  process.exit(0);
}

for (const edit of EDITS) {
  const occurrences = source.split(edit.find).length - 1;
  if (occurrences !== 1) {
    console.error(
      `Anchor not uniquely found (${occurrences}x) for "${edit.name}". Bridge layout changed; update tools/scripts/patch-claude-agent-acp.mjs.`
    );
    process.exit(1);
  }
  source = source.replace(edit.find, edit.replace);
}

writeFileSync(distPath, source);
console.log(`Patched ${distPath} with the fast/speed config option.`);
