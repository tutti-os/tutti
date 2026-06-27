#!/usr/bin/env node
// Patches/verifies Tutti-required behavior in the
// @agentclientprotocol/claude-agent-acp bridge bundle.
//
// Current patches:
// - expose an orthogonal "fast" config option backed by the Claude Agent SDK's
//   `Settings.fastMode` (via `query.applyFlagSettings({ fastMode })`) — the same
//   flag-layer path the bridge already uses for `effortLevel`
// - verify that the bridge publishes discovered slash commands after session
//   creation/resume so Tutti can expose provider-native commands without
//   waiting for a user turn
// - publish Claude Code's native /goal status attachments as ACP goal updates
//   so Tutti can show the active goal without reimplementing the command
//
// Why a codemod and not a unified diff: the bridge ships only a bundled
// `dist/acp-agent.js` and is provisioned from the ACP external agent registry,
// so there is no source tree to patch. The string anchors below are stable
// across 0.42.x–0.51.x. The
// script is idempotent (skips if a `fast` option is already present).
//
// Applied automatically after the bridge installs (InstallerPostStep in
// installer.go embeds this file). Pass --dist <path> or CLAUDE_AGENT_ACP_DIST
// to target a managed package installation. Without an explicit target, the
// script falls back to global npm locations for manual maintenance only.

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

const FAST_MODE_EDIT_GROUPS = [
  {
    name: "buildConfigOptions signature",
    variants: [
      {
        find: "function buildConfigOptions(modes, models, modelInfos, currentEffortLevel) {",
        replace:
          "function buildConfigOptions(modes, models, modelInfos, currentEffortLevel, currentFastMode) {"
      },
      {
        find: "function buildConfigOptions(modes, models, modelInfos, currentEffortLevel, agents = [], currentAgent = DEFAULT_AGENT_ID) {",
        replace:
          "function buildConfigOptions(modes, models, modelInfos, currentEffortLevel, currentFastMode, agents = [], currentAgent = DEFAULT_AGENT_ID) {"
      }
    ]
  },
  {
    name: "advertise fast config option",
    variants: [
      {
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
      }
    ]
  },
  {
    name: "seed fast at session creation",
    variants: [
      {
        find: "const configOptions = buildConfigOptions(modes, models, allowedModels, settingsManager.getSettings().effortLevel);",
        replace:
          "const configOptions = buildConfigOptions(modes, models, allowedModels, settingsManager.getSettings().effortLevel, settingsManager.getSettings().fastMode === true);"
      },
      {
        find: "const configOptions = buildConfigOptions(modes, models, allowedModels, settingsManager.getSettings().effortLevel, agents, currentAgent);",
        replace:
          "const configOptions = buildConfigOptions(modes, models, allowedModels, settingsManager.getSettings().effortLevel, settingsManager.getSettings().fastMode === true, agents, currentAgent);"
      }
    ]
  },
  {
    name: "apply initial fast mode to the SDK",
    variants: [
      {
        find: "        this.sessions[sessionId] = {",
        replace: `        // tutti patch: apply the initial fast mode so the SDK matches the UI.
        const initialFast = configOptions.find((o) => o.id === "fast");
        if (initialFast && initialFast.currentValue === "fast") {
            await q.applyFlagSettings({ fastMode: true });
        }
        this.sessions[sessionId] = {`
      }
    ]
  },
  {
    name: "preserve fast across model switch rebuild",
    variants: [
      {
        find: "session.configOptions = buildConfigOptions(session.modes, session.models, session.modelInfos, currentEffort);",
        replace:
          'session.configOptions = buildConfigOptions(session.modes, session.models, session.modelInfos, currentEffort, session.configOptions.find((o) => o.id === "fast")?.currentValue === "fast");'
      },
      {
        find: "session.configOptions = buildConfigOptions(session.modes, session.models, session.modelInfos, currentEffort, session.agents, session.currentAgent);",
        replace:
          'session.configOptions = buildConfigOptions(session.modes, session.models, session.modelInfos, currentEffort, session.configOptions.find((o) => o.id === "fast")?.currentValue === "fast", session.agents, session.currentAgent);'
      }
    ]
  },
  {
    name: "route fast config option to applyFlagSettings",
    variants: [
      {
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
    ]
  }
];

const GOAL_STATUS_EDITS = [
  {
    name: "add Claude goal status helpers",
    find: `export function isLocalCommandMetadata(content) {
    return stripLocalCommandMetadata(content) === null;
}
const PERMISSION_MODE_ALIASES = {`,
    replace: `export function isLocalCommandMetadata(content) {
    return stripLocalCommandMetadata(content) === null;
}
function tuttiClaudeGoalStatusUpdate(message) {
    const attachment = message?.attachment;
    if (!attachment || attachment.type !== "goal_status") {
        return null;
    }
    const objective = typeof attachment.condition === "string" ? attachment.condition.trim() : "";
    if (!objective) {
        return { sessionUpdate: "thread_goal_cleared" };
    }
    const goal = {
        objective,
        status: attachment.met === true ? "complete" : "active",
    };
    if (typeof attachment.reason === "string" && attachment.reason.trim() !== "") {
        goal.reason = attachment.reason.trim();
    }
    for (const key of ["iterations", "durationMs", "tokens"]) {
        if (typeof attachment[key] === "number" && Number.isFinite(attachment[key])) {
            goal[key] = attachment[key];
        }
    }
    return { sessionUpdate: "thread_goal_update", goal };
}
function tuttiClaudeGoalCommandOutputUpdate(content) {
    if (typeof content !== "string") {
        return null;
    }
    const text = stripMarkerTags(content).trim();
    if (text === "" || text.startsWith("No goal set.") || /^Goal cleared\\.?$/i.test(text)) {
        return { sessionUpdate: "thread_goal_cleared" };
    }
    const match = text.match(/^Goal set:\\s*([\\s\\S]+)$/i);
    if (!match) {
        return null;
    }
    const objective = match[1]?.trim();
    if (!objective) {
        return null;
    }
    return {
        sessionUpdate: "thread_goal_update",
        goal: { objective, status: "active" },
    };
}
const PERMISSION_MODE_ALIASES = {`
  },
  {
    name: "forward Claude goal status attachments",
    find: `                switch (message.type) {
                    case "system":`,
    replace: `                switch (message.type) {
                    case "attachment": {
                        const goalUpdate = tuttiClaudeGoalStatusUpdate(message);
                        if (goalUpdate) {
                            await this.client.sessionUpdate({
                                sessionId: message.sessionId ?? message.session_id ?? params.sessionId,
                                update: goalUpdate,
                            });
                        }
                        break;
                    }
                    case "system":`
  },
  {
    name: "forward Claude local command goal output",
    find: `                            case "local_command_output": {
                                await this.client.sessionUpdate({
                                    sessionId: message.session_id,
                                    update: {
                                        sessionUpdate: "agent_message_chunk",
                                        content: { type: "text", text: message.content },
                                    },
                                });
                                break;
                            }`,
    replace: `                            case "local_command_output": {
                                const goalUpdate = tuttiClaudeGoalCommandOutputUpdate(message.content);
                                if (goalUpdate) {
                                    await this.client.sessionUpdate({
                                        sessionId: message.session_id,
                                        update: goalUpdate,
                                    });
                                }
                                await this.client.sessionUpdate({
                                    sessionId: message.session_id,
                                    update: {
                                        sessionUpdate: "agent_message_chunk",
                                        content: { type: "text", text: message.content },
                                    },
                                });
                                break;
                            }`
  },
  {
    name: "forward Claude persisted local command goal output",
    find: `                            const stripped = stripLocalCommandMetadata(message.message.content);
                            if (typeof stripped === "string") {`,
    replace: `                            const goalUpdate = tuttiClaudeGoalCommandOutputUpdate(message.message.content);
                            if (goalUpdate) {
                                await this.client.sessionUpdate({
                                    sessionId: message.session_id ?? params.sessionId,
                                    update: goalUpdate,
                                });
                            }
                            const stripped = stripLocalCommandMetadata(message.message.content);
                            if (typeof stripped === "string") {`
  }
];

const GOAL_TRANSCRIPT_STATUS_EDITS = [
  {
    name: "add Claude transcript goal status helper",
    find: `    return { sessionUpdate: "thread_goal_update", goal };
}
function tuttiClaudeGoalCommandOutputUpdate(content) {`,
    replace: `    return { sessionUpdate: "thread_goal_update", goal };
}
async function tuttiClaudeLatestTranscriptGoalStatusUpdate(cwd, sessionId) {
    if (typeof cwd !== "string" || !cwd || typeof sessionId !== "string" || !sessionId) {
        return null;
    }
    const transcriptPath = path.join(CLAUDE_CONFIG_DIR, "projects", cwd.replace(/[^A-Za-z0-9_-]/g, "-"), \`\${sessionId}.jsonl\`);
    let transcript;
    try {
        transcript = await fs.readFile(transcriptPath, "utf8");
    } catch {
        return null;
    }
    let latest = null;
    for (const line of transcript.trimEnd().split("\\n")) {
        if (!line) {
            continue;
        }
        try {
            const entry = JSON.parse(line);
            latest = tuttiClaudeGoalStatusUpdate(entry.message ?? entry) ?? latest;
        } catch {
            continue;
        }
    }
    return latest;
}
async function tuttiClaudeSettledTranscriptGoalStatusUpdate(cwd, sessionId) {
    let latest = await tuttiClaudeLatestTranscriptGoalStatusUpdate(cwd, sessionId);
    if (!latest || latest.sessionUpdate === "thread_goal_cleared" || latest.goal?.status === "complete") {
        return latest;
    }
    // ponytail: fixed settle delays, replace with direct final attachment forwarding if the bridge exposes it.
    for (const delayMs of [75, 200]) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const next = await tuttiClaudeLatestTranscriptGoalStatusUpdate(cwd, sessionId);
        if (next) {
            latest = next;
        }
        if (latest.sessionUpdate === "thread_goal_cleared" || latest.goal?.status === "complete") {
            return latest;
        }
    }
    return latest;
}
function tuttiClaudeGoalCommandOutputUpdate(content) {`
  },
  {
    name: "forward Claude transcript goal status after result",
    find: `                        // Settle the user turn at its terminal result so the client unlocks`,
    replace: `                        const transcriptGoalUpdate = await tuttiClaudeSettledTranscriptGoalStatusUpdate(session.cwd, message.session_id ?? params.sessionId);
                        if (transcriptGoalUpdate) {
                            await this.client.sessionUpdate({
                                sessionId: params.sessionId,
                                update: transcriptGoalUpdate,
                            });
                        }
                        // Settle the user turn at its terminal result so the client unlocks`
  }
];

const GOAL_TRANSCRIPT_STATUS_UPGRADE_EDITS = [
  {
    name: "upgrade Claude transcript goal status helper",
    find: `async function tuttiClaudeLatestTranscriptGoalStatusUpdate(cwd, sessionId) {
    if (typeof cwd !== "string" || !cwd || typeof sessionId !== "string" || !sessionId) {
        return null;
    }
    const transcriptPath = path.join(CLAUDE_CONFIG_DIR, "projects", cwd.replace(/[^A-Za-z0-9_-]/g, "-"), \`\${sessionId}.jsonl\`);
    let transcript;
    try {
        transcript = await fs.readFile(transcriptPath, "utf8");
    } catch {
        return null;
    }
    let latest = null;
    for (const line of transcript.trimEnd().split("\\n")) {
        if (!line) {
            continue;
        }
        try {
            const entry = JSON.parse(line);
            latest = tuttiClaudeGoalStatusUpdate(entry.message ?? entry) ?? latest;
        } catch {
            continue;
        }
    }
    return latest;
}
function tuttiClaudeGoalCommandOutputUpdate(content) {`,
    replace: `async function tuttiClaudeLatestTranscriptGoalStatusUpdate(cwd, sessionId) {
    if (typeof cwd !== "string" || !cwd || typeof sessionId !== "string" || !sessionId) {
        return null;
    }
    const transcriptPath = path.join(CLAUDE_CONFIG_DIR, "projects", cwd.replace(/[^A-Za-z0-9_-]/g, "-"), \`\${sessionId}.jsonl\`);
    let transcript;
    try {
        transcript = await fs.readFile(transcriptPath, "utf8");
    } catch {
        return null;
    }
    let latest = null;
    for (const line of transcript.trimEnd().split("\\n")) {
        if (!line) {
            continue;
        }
        try {
            const entry = JSON.parse(line);
            latest = tuttiClaudeGoalStatusUpdate(entry.message ?? entry) ?? latest;
        } catch {
            continue;
        }
    }
    return latest;
}
async function tuttiClaudeSettledTranscriptGoalStatusUpdate(cwd, sessionId) {
    let latest = await tuttiClaudeLatestTranscriptGoalStatusUpdate(cwd, sessionId);
    if (!latest || latest.sessionUpdate === "thread_goal_cleared" || latest.goal?.status === "complete") {
        return latest;
    }
    // ponytail: fixed settle delays, replace with direct final attachment forwarding if the bridge exposes it.
    for (const delayMs of [75, 200]) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const next = await tuttiClaudeLatestTranscriptGoalStatusUpdate(cwd, sessionId);
        if (next) {
            latest = next;
        }
        if (latest.sessionUpdate === "thread_goal_cleared" || latest.goal?.status === "complete") {
            return latest;
        }
    }
    return latest;
}
function tuttiClaudeGoalCommandOutputUpdate(content) {`
  },
  {
    name: "upgrade Claude transcript goal status result forwarding",
    find: `                        const transcriptGoalUpdate = await tuttiClaudeLatestTranscriptGoalStatusUpdate(session.cwd, message.session_id ?? params.sessionId);
                        if (transcriptGoalUpdate) {
                            await this.client.sessionUpdate({
                                sessionId: params.sessionId,
                                update: transcriptGoalUpdate,
                            });
                        }`,
    replace: `                        const transcriptGoalUpdate = await tuttiClaudeSettledTranscriptGoalStatusUpdate(session.cwd, message.session_id ?? params.sessionId);
                        if (transcriptGoalUpdate) {
                            await this.client.sessionUpdate({
                                sessionId: params.sessionId,
                                update: transcriptGoalUpdate,
                            });
                        }`
  }
];

const GOAL_PROMPT_EDITS = [
  {
    name: "add Claude goal prompt mirror helper",
    find: "const PERMISSION_MODE_ALIASES = {",
    replace: `function tuttiClaudeGoalPromptUpdate(text) {
    if (typeof text !== "string") {
        return null;
    }
    const match = text.trim().match(/^\\/goal(?:\\s+([\\s\\S]*))?$/);
    if (!match) {
        return null;
    }
    const args = (match[1] ?? "").trim();
    if (!args) {
        return null;
    }
    if (args.toLowerCase() === "clear") {
        return { sessionUpdate: "thread_goal_cleared" };
    }
    return {
        sessionUpdate: "thread_goal_update",
        goal: { objective: args, status: "active" },
    };
}
const PERMISSION_MODE_ALIASES = {`
  },
  {
    name: "mirror Claude goal prompt before native execution",
    find: `        const firstText = params.prompt[0]?.type === "text" ? params.prompt[0].text : "";
        const isLocalOnlyCommand = firstText.startsWith("/") && LOCAL_ONLY_COMMANDS.has(firstText.split(" ", 1)[0]);`,
    replace: `        const firstText = params.prompt[0]?.type === "text" ? params.prompt[0].text : "";
        const goalPromptUpdate = tuttiClaudeGoalPromptUpdate(firstText);
        if (goalPromptUpdate) {
            await this.client.sessionUpdate({
                sessionId: params.sessionId,
                update: goalPromptUpdate,
            });
        }
        const isLocalOnlyCommand = firstText.startsWith("/") && LOCAL_ONLY_COMMANDS.has(firstText.split(" ", 1)[0]);`
  }
];

const TOKEN_USAGE_COMPACT_EDITS = [
  {
    name: "do not publish zero usage when compact usage probe fails",
    find: `                            case "compact_boundary": {
                                // Refresh the displayed usage immediately so the client doesn't
                                // keep showing the stale pre-compaction size (e.g. "944k/1m")
                                // right after the user sees "Compacting completed", which is
                                // confusing and wrong.
                                //
                                // Prefer the SDK's authoritative post-compaction \`used\` via
                                // getContextUsage — it reflects the real retained context
                                // (system prompt + tools + surviving messages), which the
                                // per-message API usage numbers can't give us until the next
                                // turn's result. If the control request fails, fall back to the
                                // used:0 approximation: directionally correct (context just
                                // dropped dramatically) and replaced within seconds by the next
                                // result message.
                                //
                                // \`size\` keeps coming from session.contextWindowSize (learned
                                // from modelUsage / the model heuristic) — getContextUsage's
                                // window field under-reports extended 1M windows.
                                //
                                // The "Compacting completed." text is emitted from the \`status\`
                                // handler (keyed on \`compact_result\`), not here, so the failure
                                // path gets a message too.
                                const usedTokens = await fetchContextUsedTokens(session.query, this.logger);
                                lastAssistantUsage = null;
                                lastAssistantTotalUsage = usedTokens ?? 0;
                                await this.client.sessionUpdate({
                                    sessionId: message.session_id,
                                    update: {
                                        sessionUpdate: "usage_update",
                                        used: lastAssistantTotalUsage,
                                        size: session.contextWindowSize,
                                    },
                                });
                                break;
                            }`,
    replace: `                            case "compact_boundary": {
                                // Refresh the displayed usage only when the SDK returns the
                                // authoritative post-compaction value. Publishing 0 on probe
                                // failure makes the client briefly show an impossible empty
                                // context window before the next usage event restores reality.
                                const usedTokens = await fetchContextUsedTokens(session.query, this.logger);
                                lastAssistantUsage = null;
                                if (typeof usedTokens === "number" && Number.isFinite(usedTokens)) {
                                    lastAssistantTotalUsage = usedTokens;
                                    await this.client.sessionUpdate({
                                        sessionId: message.session_id,
                                        update: {
                                            sessionUpdate: "usage_update",
                                            used: lastAssistantTotalUsage,
                                            size: session.contextWindowSize,
                                        },
                                    });
                                }
                                break;
                            }`
  }
];

function applyEdits(source, edits) {
  let nextSource = source;
  for (const edit of edits) {
    const occurrences = nextSource.split(edit.find).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `Anchor not uniquely found (${occurrences}x) for "${edit.name}".`
      );
    }
    nextSource = nextSource.replace(edit.find, edit.replace);
  }
  return nextSource;
}

function applyEditGroups(source, groups) {
  let nextSource = source;
  for (const group of groups) {
    const matches = group.variants
      .map((variant) => ({
        variant,
        occurrences: nextSource.split(variant.find).length - 1
      }))
      .filter((match) => match.occurrences > 0);
    const totalOccurrences = matches.reduce(
      (sum, match) => sum + match.occurrences,
      0
    );
    if (totalOccurrences !== 1) {
      throw new Error(
        `Anchor not uniquely found (${totalOccurrences}x) for "${group.name}".`
      );
    }
    const match = matches[0];
    if (match.occurrences !== 1) {
      throw new Error(
        `Anchor not uniquely found (${match.occurrences}x) for "${group.name}".`
      );
    }
    nextSource = nextSource.replace(match.variant.find, match.variant.replace);
  }
  return nextSource;
}

function hasLifecycleCommandUpdates(source) {
  return (
    source.includes("this.sendAvailableCommandsUpdate(response.sessionId)") &&
    source.includes("this.sendAvailableCommandsUpdate(params.sessionId)")
  );
}

function hasGoalStatusUpdates(source) {
  return (
    source.includes("function tuttiClaudeGoalStatusUpdate") &&
    source.includes('sessionUpdate: "thread_goal_update"')
  );
}

function hasGoalTranscriptStatusUpdates(source) {
  return (
    source.includes("function tuttiClaudeSettledTranscriptGoalStatusUpdate") &&
    source.includes(
      "const transcriptGoalUpdate = await tuttiClaudeSettledTranscriptGoalStatusUpdate"
    )
  );
}

function hasGoalPromptUpdates(source) {
  return (
    source.includes("function tuttiClaudeGoalPromptUpdate") &&
    source.includes(
      "const goalPromptUpdate = tuttiClaudeGoalPromptUpdate(firstText)"
    )
  );
}

function hasCompactUsageProbeFailureFix(source) {
  return (
    source.includes("authoritative post-compaction value") &&
    !source.includes("lastAssistantTotalUsage = usedTokens ?? 0")
  );
}

const distPath = resolveDistPath();
if (!existsSync(distPath)) {
  console.error(`claude-agent-acp bundle not found at: ${distPath}`);
  console.error(
    "Install it first from the ACP external agent registry or pass --dist <path>."
  );
  process.exit(1);
}

let source = readFileSync(distPath, "utf8");
let changed = false;
if (/id:\s*"fast"/.test(source)) {
  console.log(`Already patched (fast config option present): ${distPath}`);
} else {
  try {
    source = applyEditGroups(source, FAST_MODE_EDIT_GROUPS);
    changed = true;
  } catch (error) {
    console.error(
      `claude-agent-acp fast-mode patch failed: ${error.message} Bridge layout changed; update services/tuttid/service/agentstatus/assets/patch-claude-agent-acp.mjs.`
    );
    process.exit(1);
  }
}

if (hasLifecycleCommandUpdates(source)) {
  console.log(
    `Already supports lifecycle slash-command discovery updates: ${distPath}`
  );
} else {
  console.error(
    "claude-agent-acp does not publish slash-command discovery after session lifecycle events; update the bridge or this patch script."
  );
  process.exit(1);
}

if (hasGoalStatusUpdates(source)) {
  console.log(`Already supports Claude /goal status updates: ${distPath}`);
} else {
  try {
    source = applyEdits(source, GOAL_STATUS_EDITS);
    changed = true;
  } catch (error) {
    console.error(
      `claude-agent-acp goal-status patch failed: ${error.message} Bridge layout changed; update services/tuttid/service/agentstatus/assets/patch-claude-agent-acp.mjs.`
    );
    process.exit(1);
  }
}

if (hasGoalTranscriptStatusUpdates(source)) {
  console.log(
    `Already mirrors Claude /goal transcript status updates: ${distPath}`
  );
} else {
  try {
    source = applyEdits(
      source,
      source.includes("function tuttiClaudeLatestTranscriptGoalStatusUpdate")
        ? GOAL_TRANSCRIPT_STATUS_UPGRADE_EDITS
        : GOAL_TRANSCRIPT_STATUS_EDITS
    );
    changed = true;
  } catch (error) {
    console.error(
      `claude-agent-acp goal-transcript-status patch failed: ${error.message} Bridge layout changed; update services/tuttid/service/agentstatus/assets/patch-claude-agent-acp.mjs.`
    );
    process.exit(1);
  }
}

if (hasGoalPromptUpdates(source)) {
  console.log(`Already mirrors Claude /goal prompt updates: ${distPath}`);
} else {
  try {
    source = applyEdits(source, GOAL_PROMPT_EDITS);
    changed = true;
  } catch (error) {
    console.error(
      `claude-agent-acp goal-prompt patch failed: ${error.message} Bridge layout changed; update services/tuttid/service/agentstatus/assets/patch-claude-agent-acp.mjs.`
    );
    process.exit(1);
  }
}

if (hasCompactUsageProbeFailureFix(source)) {
  console.log(
    `Already avoids zero usage on Claude compact usage probe failures: ${distPath}`
  );
} else {
  try {
    source = applyEdits(source, TOKEN_USAGE_COMPACT_EDITS);
    changed = true;
  } catch (error) {
    console.error(
      `claude-agent-acp compact-usage patch failed: ${error.message} Bridge layout changed; update services/tuttid/service/agentstatus/assets/patch-claude-agent-acp.mjs.`
    );
    process.exit(1);
  }
}

if (changed) {
  writeFileSync(distPath, source);
  console.log(`Patched ${distPath} with Tutti bridge extensions.`);
} else {
  console.log(`No bridge patch changes needed: ${distPath}`);
}
