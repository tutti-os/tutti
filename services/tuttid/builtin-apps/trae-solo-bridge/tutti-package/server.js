const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, execFile, execFileSync } = require("child_process");
const { URL, fileURLToPath } = require("url");

const HOST = process.env.TUTTI_APP_HOST || "127.0.0.1";
const PORT = process.env.TUTTI_APP_PORT;
const DATA_DIR =
  process.env.TUTTI_APP_DATA_DIR || path.join(process.cwd(), ".data");
const LOG_DIR =
  process.env.TUTTI_APP_LOG_DIR || path.join(process.cwd(), ".logs");
if (!PORT) {
  console.error("TUTTI_APP_PORT is required");
  process.exit(64);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, "runs.json");

const DEFAULT_TRAE_SOLO_APP = "TRAE SOLO CN";
const DEFAULT_TRAE_SOLO_BUNDLE_ID = "cn.trae.solo.app";
const DEFAULT_TRAE_SOLO_CLI =
  "/Applications/TRAE SOLO CN.app/Contents/Resources/app/bin/trae-solo-cn";
const DEFAULT_CODEX_CLI =
  process.env.CODEX_CLI || "/Users/dadong/.local/bin/codex";
const VALID_SOLO_MODES = new Set(["work", "code", "design"]);
const VALID_CODEX_MODES = new Set(["atoa"]);
const VALID_SESSION_MODES = new Set(["new", "current", "workspace", "reuse"]);
const SESSION_LABELS = {
  new: "新开会话",
  current: "接力当前客户端会话",
  workspace: "接力已识别工作区会话",
  reuse: "复用当前会话"
};
const MODE_LABELS = {
  work: "PPT / Work",
  code: "编程 / Code",
  design: "前端设计 / Design"
};
const CODEX_MODE_LABELS = {
  atoa: "AtoA / Agent-to-Agent"
};

function loadRuns() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveRuns(runs) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(runs, null, 2));
}
function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type + "; charset=utf-8" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 2_000_000) {
        req.destroy();
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}
function runId() {
  return (
    new Date()
      .toISOString()
      .replace(/[-:.TZ]/g, "")
      .slice(0, 14) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  );
}
function resultPaths(projectPath, id) {
  const dir = path.join(projectPath, ".tutti-trae-solo");
  return {
    dir,
    md: path.join(dir, `${id}.result.md`),
    json: path.join(dir, `${id}.result.json`)
  };
}
function makePrompt(projectPath, id, prompt, mode, sessionMode) {
  const rp = resultPaths(projectPath, id);
  return `你现在在 TRAE SOLO CN 独立 App 的 ${mode} 模式（${MODE_LABELS[mode]}）里接到一个 Tutti Workspace App 转交任务。\n\n项目目录：${projectPath}\n任务ID：${id}\n模式：${mode}\n会话：${SESSION_LABELS[sessionMode] || sessionMode}\n\n请完成下面任务，并把结果写入：\n${rp.md}\n\n如果有结构化状态，也可以写入：\n${rp.json}\n\n硬性要求：\n1. 先阅读项目必要文件，不要只凭猜测。\n2. 如果执行了命令，把关键命令和结果写进结果文件。\n3. 如果任务无法完成，写清楚卡点。\n4. 完成后结果文件第一行写：TRAE_SOLO_RESULT ${id}\n5. 不要写到其他目录；只使用上面的项目目录和结果路径。\n\n用户任务：\n${prompt}\n`;
}
function makeCodexPrompt(projectPath, id, prompt, mode) {
  const rp = resultPaths(projectPath, id);
  return `你现在是 Codex CLI，通过 Tutti Workspace App 的 Codex ${mode} 模式（${CODEX_MODE_LABELS[mode]}）接到任务。\n\n项目目录：${projectPath}\n任务ID：${id}\n模式：${mode}\n\nAtoA 协作要求：\n1. 把自己当成被 Moe/Tutti 面板调度的下游 coding agent，先阅读项目必要文件，不要只凭猜测。\n2. 可以在项目目录内修改文件、运行必要检查；不要越权写入无关目录。\n3. 如果遇到需要人工授权的外部副作用，停止并在最终结果里说明。\n4. 最终回复必须包含：已做改动、验证命令和结果、未完成卡点。\n5. 结果会由 Codex CLI 写入：${rp.md}\n6. 最终结果第一行写：CODEX_RESULT ${id}\n\n用户任务：\n${prompt}\n`;
}
function resolveCodexCli(cliPath) {
  const explicit = cliPath || DEFAULT_CODEX_CLI;
  if (explicit && fs.existsSync(explicit)) return explicit;
  try {
    return execFileSync("/bin/sh", ["-lc", "command -v codex"], {
      timeout: 5000,
      encoding: "utf8"
    }).trim();
  } catch {
    return explicit;
  }
}
async function launchViaCodex(
  projectPath,
  transferPrompt,
  mode,
  cliPath,
  id,
  rp
) {
  const cli = resolveCodexCli(cliPath);
  if (!cli || !fs.existsSync(cli))
    return {
      ok: false,
      cli,
      mode,
      step: "find-codex",
      error: `Codex CLI not found: ${cli}`
    };
  const logPath = path.join(LOG_DIR, `codex-${id}.log`);
  const args = [
    "--cd",
    projectPath,
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
    "exec",
    "--output-last-message",
    rp.md,
    transferPrompt
  ];
  const out = fs.openSync(logPath, "a");
  const child = spawn(cli, args, {
    cwd: projectPath,
    env: process.env,
    detached: true,
    stdio: ["ignore", out, out]
  });
  child.unref();
  return {
    ok: true,
    cli,
    args,
    mode,
    step: "codex-exec",
    transport: "codex-cli",
    pid: child.pid,
    logPath,
    note: "Codex 以 AtoA 模式在后台执行；结果写入项目内结果文件，日志写入 app log 目录。"
  };
}
function copyToClipboard(text) {
  return new Promise((resolve, reject) => {
    const p = spawn("pbcopy");
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error("pbcopy failed " + code))
    );
    p.stdin.end(text);
  });
}
function execFileP(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: opts.timeout || 30000, cwd: opts.cwd },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          file,
          args,
          exitCode: err && typeof err.code !== "undefined" ? err.code : 0,
          error: err ? String(err.message || err) : "",
          stdout: String(stdout || ""),
          stderr: String(stderr || "")
        });
      }
    );
  });
}
function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function fileUriToPath(uri) {
  if (!uri || typeof uri !== "string") return "";
  try {
    return uri.startsWith("file://") ? fileURLToPath(uri) : uri;
  } catch {
    return uri.replace(/^file:\/\//, "");
  }
}
function workspaceLabelFromPath(p) {
  if (!p) return "未知工作区";
  const parts = p.split(path.sep).filter(Boolean);
  return parts.slice(-2).join(path.sep) || p;
}
function loadTraeWindowsState() {
  const storage =
    readJsonSafe(
      path.join(
        process.env.HOME || "",
        "Library/Application Support/TRAE SOLO CN/User/globalStorage/storage.json"
      )
    ) || {};
  return storage.windowsState || {};
}
function latestLogFiles(pattern, max = 8) {
  const root = path.join(
    process.env.HOME || "",
    "Library/Application Support/TRAE SOLO CN/logs"
  );
  const out = [];
  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (pattern.test(p)) {
        try {
          out.push({ path: p, mtimeMs: fs.statSync(p).mtimeMs });
        } catch {}
      }
    }
  }
  walk(root);
  return out
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, max)
    .map((x) => x.path);
}
function loadLiteModeStateMap() {
  const db = path.join(
    process.env.HOME || "",
    "Library/Application Support/TRAE SOLO CN/User/globalStorage/state.vscdb"
  );
  if (!fs.existsSync(db)) return {};
  try {
    const out = execFileSync(
      "sqlite3",
      [
        db,
        "select value from ItemTable where key like 'solo-lite-mode-state-map-%' order by key limit 1;"
      ],
      { timeout: 5000, encoding: "utf8" }
    ).trim();
    return out ? JSON.parse(out) : {};
  } catch {
    return {};
  }
}
function loadSoloLiteRouteSessionId() {
  const db = path.join(
    process.env.HOME || "",
    "Library/Application Support/TRAE SOLO CN/User/globalStorage/state.vscdb"
  );
  if (!fs.existsSync(db)) return "";
  try {
    const route = execFileSync(
      "sqlite3",
      [
        db,
        "select value from ItemTable where key like 'solo-lite:route:%' order by key limit 1;"
      ],
      { timeout: 5000, encoding: "utf8" }
    ).trim();
    const m = route.match(/\/session\/([^/?#]+)/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}
function modeDisplay(mode) {
  return { work: "Work", code: "Code", design: "Design" }[mode] || "未知模式";
}
function normalizeLiteSession(raw, mode) {
  if (!raw || !raw.chat_session_id) return null;
  const source = raw.source || {};
  const projectPath =
    raw.workspacePath ||
    raw.mainFolder ||
    source.local_folder ||
    source.remote_folder ||
    "";
  const title = raw.title || raw.name || raw.task_title || raw.chat_session_id;
  const subtitle =
    raw.description ||
    raw.subTitle ||
    raw.subtitle ||
    raw.task_description ||
    "";
  return {
    id: `chat:${raw.chat_session_id}`,
    kind: "chat",
    chatSessionId: raw.chat_session_id,
    mode: raw.mode || mode || "",
    label: `${modeDisplay(raw.mode || mode)}｜${title}${subtitle ? "｜" + subtitle : ""}`,
    title: String(title),
    subtitle: String(subtitle || ""),
    status: raw.status ?? null,
    projectPath,
    workspacePath: projectPath,
    updatedAt:
      raw.updateAt || raw.updated_at || raw.createdAt || raw.created_at || 0,
    source: "globalStorage.state.vscdb:solo-lite-mode-state-map",
    rawSession: raw
  };
}
function sessionsFromLiteModeState() {
  const state = loadLiteModeStateMap();
  const out = [];
  for (const [mode, value] of Object.entries(state || {})) {
    const item = normalizeLiteSession(value && value.session, mode);
    if (item) out.push(item);
  }
  return out.sort(
    (a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
  );
}
function titleForChatSession(sessionId) {
  const fromState = sessionsFromLiteModeState().find(
    (s) => s.chatSessionId === sessionId
  );
  if (fromState && fromState.title) return fromState.title;
  const workDir = path.join(process.env.HOME || "", ".trae-cn/work", sessionId);
  const plan = readJsonSafe(path.join(workDir, "plan.json"));
  if (plan && plan.plan && plan.plan.title) return String(plan.plan.title);
  const files = fs.existsSync(workDir)
    ? fs.readdirSync(workDir).slice(0, 3)
    : [];
  if (files.length) return `${sessionId} · ${files.join(", ")}`;
  return sessionId;
}
function scanChatSessionsFromLogs() {
  const sessions = new Map();
  const files = latestLogFiles(/(renderer\.log|ai-agent_.*_stdout\.log)$/, 24);
  const statusRe =
    /Session status changed: \{[^}]*"sessionId":"([^"]+)"[^}]*"nextStatus":(\d+)/g;
  const initRe = /Initializing session \(Lite\):\s*([a-zA-Z0-9_-]+)/g;
  const sendRe = /sendMessage started, sessionId:\s*([a-zA-Z0-9_-]+)/g;
  const fixedRe = /fixedConversationId":"([^"]+)"/g;
  const updatedRe =
    /session_updated \{"chat_session_id":"([^"]+)"[^}]*?"title":"([^"]+)"[^}]*?"updated_at":(\d+)/g;
  const onDataRe =
    /onData \{ chat_session_id: "([^"]+)"[\s\S]{0,1200}?status: ([A-Za-z]+)[\s\S]{0,800}?mode: Some\("([^"]+)"\)[\s\S]{0,1600}?title: Some\("([^"]+)"\)/g;
  for (const file of files) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const add = (id, source, status, title, mode, updatedAt) => {
      if (!id || id === "(none)" || id === "undefined" || id === "homepage")
        return;
      const prev = sessions.get(id) || {
        id: `chat:${id}`,
        kind: "chat",
        chatSessionId: id,
        label: "",
        title: "",
        status: null,
        mode: "",
        sources: [],
        mtimeMs: 0,
        updatedAt: 0
      };
      if (title) prev.title = String(title);
      if (!prev.title) prev.title = titleForChatSession(id);
      if (mode) prev.mode = String(mode).toLowerCase();
      prev.label = `${modeDisplay(prev.mode)}｜${prev.title}`;
      if (status !== undefined && status !== null)
        prev.status = isNaN(Number(status)) ? status : Number(status);
      if (updatedAt)
        prev.updatedAt = Math.max(
          Number(prev.updatedAt) || 0,
          Number(updatedAt) || 0
        );
      prev.sources.push(source);
      try {
        prev.mtimeMs = Math.max(prev.mtimeMs || 0, fs.statSync(file).mtimeMs);
      } catch {}
      const workDir = path.join(process.env.HOME || "", ".trae-cn/work", id);
      if (fs.existsSync(workDir)) prev.workDir = workDir;
      sessions.set(id, prev);
    };
    for (const re of [initRe, sendRe, fixedRe]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) add(m[1], path.basename(file));
    }
    statusRe.lastIndex = 0;
    let m;
    while ((m = statusRe.exec(text))) add(m[1], path.basename(file), m[2]);
    updatedRe.lastIndex = 0;
    while ((m = updatedRe.exec(text)))
      add(m[1], path.basename(file), null, m[2], "", m[3]);
    onDataRe.lastIndex = 0;
    while ((m = onDataRe.exec(text)))
      add(m[1], path.basename(file), m[2], m[4], m[3]);
  }
  return [...sessions.values()].sort(
    (a, b) =>
      (Number(b.updatedAt) || b.mtimeMs || 0) -
      (Number(a.updatedAt) || a.mtimeMs || 0)
  );
}

function scanWorkspaceStorage() {
  const root = path.join(
    process.env.HOME || "",
    "Library/Application Support/TRAE SOLO CN/User/workspaceStorage"
  );
  const out = [];
  try {
    for (const id of fs.readdirSync(root)) {
      const dir = path.join(root, id);
      const ws = readJsonSafe(path.join(dir, "workspace.json"));
      if (!ws) continue;
      let projectPath = "";
      let workspaceConfig = "";
      if (ws.folder) projectPath = fileUriToPath(ws.folder);
      if (ws.workspace) workspaceConfig = fileUriToPath(ws.workspace);
      if (!projectPath && workspaceConfig) {
        const cfg = readJsonSafe(workspaceConfig);
        const firstFolder =
          cfg &&
          Array.isArray(cfg.folders) &&
          cfg.folders[0] &&
          (cfg.folders[0].path || cfg.folders[0].uri);
        if (firstFolder) {
          const rawFolder = firstFolder.startsWith("file:")
            ? fileUriToPath(firstFolder)
            : firstFolder;
          const candidates = [
            path.resolve(path.dirname(workspaceConfig), rawFolder),
            path.resolve(
              process.env.HOME || "",
              "Library/Application Support/TRAE SOLO CN",
              rawFolder
            ),
            path.resolve(
              process.env.HOME || "",
              "Library/Application Support/TRAE SOLO CN/User",
              rawFolder
            )
          ];
          projectPath =
            candidates.find((c) => fs.existsSync(c)) || candidates[0];
        }
      }
      const stat = fs.statSync(path.join(dir, "workspace.json"));
      out.push({
        id,
        kind: "workspace",
        label: workspaceLabelFromPath(projectPath || workspaceConfig),
        projectPath,
        workspaceConfig,
        mtimeMs: stat.mtimeMs
      });
    }
  } catch {}
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
function listTraeSessions() {
  const windowsState = loadTraeWindowsState();
  const workspaces = scanWorkspaceStorage();
  const sessions = [];
  const seen = new Set();
  const add = (item) => {
    if (!item || !item.id || seen.has(item.id)) return;
    seen.add(item.id);
    sessions.push(item);
  };
  const last =
    windowsState.lastActiveWindow &&
    windowsState.lastActiveWindow.workspaceIdentifier;
  const stateSessions = sessionsFromLiteModeState();
  const logSessions = scanChatSessionsFromLogs();
  const stateById = new Map(stateSessions.map((s) => [s.chatSessionId, s]));
  const chatSessions = [...stateSessions];
  for (const c of logSessions) {
    if (stateById.has(c.chatSessionId)) continue;
    chatSessions.push(c);
  }
  const routeSessionId = loadSoloLiteRouteSessionId();
  const activeChat =
    stateSessions.find((s) => s.chatSessionId === routeSessionId) ||
    chatSessions.find((s) => s.chatSessionId === routeSessionId) ||
    stateSessions[0] ||
    chatSessions[0];
  if (activeChat)
    add({
      ...activeChat,
      id: `current-chat:${activeChat.chatSessionId}`,
      kind: "current-chat",
      label: `当前${modeDisplay(activeChat.mode)}｜${activeChat.title}${activeChat.subtitle ? "｜" + activeChat.subtitle : ""}`,
      isLastActive: true
    });
  for (const c of chatSessions) add(c);
  if (last && last.id) {
    const matched = workspaces.find((w) => w.id === last.id) || {};
    add({
      id: `current:${last.id}`,
      kind: "current",
      label: `当前客户端窗口：${matched.label || last.id}`,
      workspaceId: last.id,
      projectPath: matched.projectPath || "",
      workspaceConfig: fileUriToPath(
        last.configURIPath || matched.workspaceConfig || ""
      ),
      isLastActive: true
    });
  }
  for (const w of workspaces)
    add({
      id: `workspace:${w.id}`,
      kind: "workspace",
      label: `已识别工作区：${w.label}`,
      workspaceId: w.id,
      projectPath: w.projectPath || "",
      workspaceConfig: w.workspaceConfig || "",
      mtimeMs: w.mtimeMs
    });
  return {
    ok: true,
    source:
      "TRAE SOLO CN globalStorage.state.vscdb solo-lite-mode-state-map + logs + workspaceStorage + ~/.trae-cn/work",
    sessions,
    chatSessionCount: chatSessions.length,
    stateSessionCount: stateSessions.length,
    windowsState: {
      lastActiveWindow: windowsState.lastActiveWindow || null,
      openedWindows: windowsState.openedWindows || []
    },
    limitation:
      "现在会优先读取 Trae Solo 真实客户端状态库里的 lite mode 会话标题/ID/项目路径；但 Trae CLI 仍未暴露按 chatSessionId 投递参数，选择真实聊天会话时会用 --reuse-window 接力到当前客户端。"
  };
}
function isTraeSoloRunning() {
  return new Promise((resolve) => {
    execFile(
      "osascript",
      [
        "-e",
        `tell application "System Events" to get unix id of every process whose bundle identifier is "${DEFAULT_TRAE_SOLO_BUNDLE_ID}"`
      ],
      { timeout: 10000 },
      (err, stdout, stderr) => {
        const pids = String(stdout || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        resolve({
          running: !err && pids.length > 0,
          bundleId: DEFAULT_TRAE_SOLO_BUNDLE_ID,
          pids,
          error: err ? String(err.message || err) : "",
          stderr: String(stderr || "")
        });
      }
    );
  });
}
async function hideTraeSolo(appName) {
  const targetApp = appName || DEFAULT_TRAE_SOLO_APP;
  const hidden = await execFileP(
    "osascript",
    [
      "-e",
      `tell application "System Events" to set visible of every process whose bundle identifier is "${DEFAULT_TRAE_SOLO_BUNDLE_ID}" to false`
    ],
    { timeout: 10000 }
  );
  return { ok: hidden.ok, appName: targetApp, hidden };
}
async function keepTraeSoloBackground(appName) {
  const hidden = await hideTraeSolo(appName);
  return { ok: hidden.ok, backgroundOnly: true, hidden };
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function ensureDevtools(appName) {
  let probe = await execFileP(
    "curl",
    ["-sSf", "http://127.0.0.1:9229/json/version"],
    { timeout: 5000 }
  );
  if (probe.ok)
    return {
      ok: true,
      alreadyOpen: true,
      probe,
      hidden: await hideTraeSolo(appName)
    };
  const before = await isTraeSoloRunning();
  if (before.running) {
    await execFileP(
      "osascript",
      ["-e", `tell application "${appName || DEFAULT_TRAE_SOLO_APP}" to quit`],
      { timeout: 10000 }
    );
    await sleep(3000);
  }
  const opened = await execFileP(
    "open",
    [
      "-jna",
      `/Applications/${appName || DEFAULT_TRAE_SOLO_APP}.app`,
      "--args",
      "--remote-debugging-port=9229"
    ],
    { timeout: 10000 }
  );
  await sleep(8000);
  const hidden = await hideTraeSolo(appName);
  probe = await execFileP(
    "curl",
    ["-sSf", "http://127.0.0.1:9229/json/version"],
    { timeout: 5000 }
  );
  return { ok: probe.ok, alreadyOpen: false, before, opened, hidden, probe };
}
async function launchViaDevtools(
  projectPath,
  transferPrompt,
  mode,
  sessionMode,
  cliPath,
  appName,
  targetSession
) {
  const devtools = await ensureDevtools(appName);
  if (!devtools.ok)
    return {
      ok: false,
      mode,
      sessionMode,
      step: "ensure-devtools",
      devtools,
      targetSession
    };
  const openProject = await execFileP(
    cliPath || DEFAULT_TRAE_SOLO_CLI,
    ["--reuse-window", projectPath],
    { timeout: 45000 }
  );
  const hiddenAfterOpenProject = await hideTraeSolo(appName);
  const script = path.join(__dirname, "devtools_send.js");
  if (!fs.existsSync(script))
    return {
      ok: false,
      mode,
      sessionMode,
      step: "devtools-script",
      error: `devtools_send.js not found: ${script}`,
      devtools,
      openProject,
      hiddenAfterOpenProject,
      targetSession
    };
  const send = await execFileP(
    process.execPath,
    [script, mode, transferPrompt],
    { timeout: 90000, cwd: projectPath }
  );
  const hiddenAfterSend = await hideTraeSolo(appName);
  let parsed = null;
  try {
    parsed = JSON.parse(send.stdout || "{}");
  } catch {}
  const ok = !!(send.ok && parsed && parsed.ok);
  return {
    ok,
    mode,
    sessionMode,
    step: "devtools-send",
    transport: "devtools-cdp",
    devtools,
    openProject,
    hiddenAfterOpenProject,
    hiddenAfterSend,
    targetSession,
    send,
    parsed,
    note: "DevTools 后台控制 Trae Solo 页面：启动时用 open -j 隐藏窗口，投递前后自动 hide；以 createSessionAndSendMessage / send_message accepted / 结果文件作为验证。"
  };
}
async function launchViaCli(
  projectPath,
  transferPrompt,
  mode,
  sessionMode,
  cliPath,
  appName,
  targetSession
) {
  if (sessionMode === "new")
    return launchViaDevtools(
      projectPath,
      transferPrompt,
      mode,
      sessionMode,
      cliPath,
      appName,
      targetSession
    );
  const cli = cliPath || DEFAULT_TRAE_SOLO_CLI;
  if (!fs.existsSync(cli))
    return { ok: false, cli, error: `Trae Solo CLI not found: ${cli}` };
  const before = await isTraeSoloRunning();
  let openProject;
  const selectedProjectPath =
    targetSession && targetSession.projectPath
      ? targetSession.projectPath
      : projectPath;
  if (before.running) {
    openProject = await keepTraeSoloBackground(appName);
    if (
      sessionMode === "workspace" &&
      selectedProjectPath &&
      fs.existsSync(selectedProjectPath)
    ) {
      const focusWorkspace = await execFileP(
        cli,
        ["--reuse-window", selectedProjectPath],
        { timeout: 45000 }
      );
      openProject.focusWorkspace = focusWorkspace;
      openProject.hiddenAfterFocusWorkspace = await hideTraeSolo(appName);
    }
  } else {
    openProject = await execFileP(
      cli,
      ["--new-window", selectedProjectPath || projectPath],
      { timeout: 45000 }
    );
  }
  if (!openProject.ok)
    return {
      ok: false,
      cli,
      mode,
      step: before.running ? "background-existing" : "open-project",
      alreadyRunning: before.running,
      before,
      openProject,
      targetSession
    };
  const chatWindowArg =
    sessionMode === "new" ? "--new-window" : "--reuse-window";
  const chatCwd =
    selectedProjectPath && fs.existsSync(selectedProjectPath)
      ? selectedProjectPath
      : projectPath;
  const chat = await execFileP(
    cli,
    ["chat", "--mode", mode, chatWindowArg, transferPrompt],
    { timeout: 45000, cwd: chatCwd }
  );
  return {
    ok: chat.ok,
    cli,
    mode,
    sessionMode,
    chatWindowArg,
    step: "chat",
    alreadyRunning: before.running,
    before,
    openProject,
    targetSession,
    chat
  };
}
async function openTrae(projectPath, appName) {
  const targetApp = appName || DEFAULT_TRAE_SOLO_APP;
  const before = await isTraeSoloRunning();
  if (before.running) {
    const background = await keepTraeSoloBackground(targetApp);
    return {
      ok: background.ok,
      appName: targetApp,
      alreadyRunning: true,
      before,
      background
    };
  }
  const opened = await execFileP(
    "open",
    ["-jna", `/Applications/${targetApp}.app`, "--args", projectPath],
    { timeout: 10000 }
  );
  const hidden = await hideTraeSolo(targetApp);
  return {
    ok: opened.ok,
    appName: targetApp,
    alreadyRunning: false,
    before,
    opened,
    hidden
  };
}
async function handleApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/launch") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const projectPath = path.resolve(String(body.projectPath || ""));
    const prompt = String(body.prompt || "");
    const agent = String(body.agent || "trae").toLowerCase();
    const appName = body.appName ? String(body.appName) : undefined;
    const cliPath = body.cliPath ? String(body.cliPath) : undefined;
    const codexCliPath = body.codexCliPath
      ? String(body.codexCliPath)
      : undefined;
    const mode = String(body.mode || "code").toLowerCase();
    const codexMode = String(body.codexMode || "atoa").toLowerCase();
    const transfer = String(body.transfer || "cli").toLowerCase();
    const sessionMode = String(body.sessionMode || "new").toLowerCase();
    const requestedSessionId = body.sessionId ? String(body.sessionId) : "";
    if (
      !projectPath ||
      !fs.existsSync(projectPath) ||
      !fs.statSync(projectPath).isDirectory()
    )
      return send(res, 400, {
        ok: false,
        error: "projectPath must be an existing directory"
      });
    if (!prompt.trim())
      return send(res, 400, { ok: false, error: "prompt is required" });
    if (!["trae", "codex"].includes(agent))
      return send(res, 400, {
        ok: false,
        error: "agent must be trae or codex"
      });
    if (agent === "codex" && !VALID_CODEX_MODES.has(codexMode))
      return send(res, 400, {
        ok: false,
        error: "codexMode must be one of: atoa"
      });
    if (agent === "trae" && !VALID_SOLO_MODES.has(mode))
      return send(res, 400, {
        ok: false,
        error: "mode must be one of: work, code, design"
      });
    if (agent === "trae" && !VALID_SESSION_MODES.has(sessionMode))
      return send(res, 400, {
        ok: false,
        error: "sessionMode must be one of: new, current, workspace, reuse"
      });
    const id = runId();
    const rp = resultPaths(projectPath, id);
    fs.mkdirSync(rp.dir, { recursive: true });
    if (agent === "codex") {
      const transferPrompt = makeCodexPrompt(
        projectPath,
        id,
        prompt,
        codexMode
      );
      const launched = await launchViaCodex(
        projectPath,
        transferPrompt,
        codexMode,
        codexCliPath,
        id,
        rp
      );
      const warning = launched.ok
        ? "Codex 已在后台启动；请用“检查结果”查看输出文件，或看日志路径确认进度。"
        : "Codex 启动失败，请检查 CLI 路径和登录状态。";
      const run = {
        id,
        agent,
        mode: codexMode,
        modeLabel: CODEX_MODE_LABELS[codexMode],
        projectPath,
        cliPath: launched.cli || codexCliPath || DEFAULT_CODEX_CLI,
        prompt,
        resultMarkdown: rp.md,
        resultJson: rp.json,
        createdAt: new Date().toISOString(),
        launched,
        cliAccepted: launched.ok,
        warning
      };
      const runs = loadRuns();
      runs.unshift(run);
      saveRuns(runs.slice(0, 100));
      return send(res, 200, { ok: launched.ok, run, warning });
    }
    const sessionCatalog = listTraeSessions();
    const targetSession = requestedSessionId
      ? sessionCatalog.sessions.find((s) => s.id === requestedSessionId)
      : sessionMode === "current"
        ? sessionCatalog.sessions.find(
            (s) =>
              s.kind === "current-chat" ||
              s.kind === "chat" ||
              s.kind === "current"
          )
        : null;
    const effectiveMode =
      targetSession &&
      VALID_SOLO_MODES.has(String(targetSession.mode || "").toLowerCase())
        ? String(targetSession.mode).toLowerCase()
        : mode;
    const transferPrompt = makePrompt(
      projectPath,
      id,
      prompt,
      effectiveMode,
      sessionMode
    );
    await copyToClipboard(transferPrompt);
    let launched;
    if (transfer === "clipboard") {
      launched = await openTrae(projectPath, appName);
    } else {
      launched = await launchViaCli(
        projectPath,
        transferPrompt,
        effectiveMode,
        sessionMode,
        cliPath,
        appName,
        targetSession
      );
    }
    const cliAccepted = !!(
      launched &&
      launched.ok &&
      launched.chat &&
      launched.chat.ok
    );
    const warning =
      transfer === "cli"
        ? "CLI exitCode=0 只能说明 trae-solo-cn 命令接受了请求；Solo Lite 目前未暴露按 chatSessionId 投递/确认 API，请以客户端是否出现消息或结果文件为准。Prompt 已复制到剪贴板，可手动粘贴兜底。"
        : "Prompt 已复制到剪贴板，请在 Trae Solo 客户端手动粘贴提交。";
    const run = {
      id,
      mode: effectiveMode,
      requestedMode: mode,
      modeLabel: MODE_LABELS[effectiveMode],
      sessionMode,
      sessionLabel: SESSION_LABELS[sessionMode],
      sessionId: requestedSessionId,
      targetSession: targetSession || null,
      transfer,
      projectPath,
      appName: appName || DEFAULT_TRAE_SOLO_APP,
      cliPath: cliPath || DEFAULT_TRAE_SOLO_CLI,
      prompt,
      resultMarkdown: rp.md,
      resultJson: rp.json,
      createdAt: new Date().toISOString(),
      launched,
      cliAccepted,
      warning
    };
    const runs = loadRuns();
    runs.unshift(run);
    saveRuns(runs.slice(0, 100));
    return send(res, 200, {
      ok: launched.ok,
      run,
      clipboard: "prompt copied as fallback",
      warning
    });
  }
  if (req.method === "GET" && url.pathname === "/api/sessions")
    return send(res, 200, listTraeSessions());
  if (req.method === "GET" && url.pathname === "/api/runs")
    return send(res, 200, { ok: true, runs: loadRuns() });
  if (req.method === "GET" && url.pathname.startsWith("/api/result/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const run = loadRuns().find((r) => r.id === id);
    if (!run) return send(res, 404, { ok: false, error: "run not found" });
    const files = [];
    for (const p of [run.resultMarkdown, run.resultJson])
      if (fs.existsSync(p))
        files.push({
          path: p,
          content: fs.readFileSync(p, "utf8"),
          mtimeMs: fs.statSync(p).mtimeMs
        });
    return send(res, 200, { ok: true, run, done: files.length > 0, files });
  }
  send(res, 404, { ok: false, error: "not found" });
}
const html = `<!doctype html><meta charset="utf-8"><title>Agent Bridge</title><style>
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}main{max-width:960px;margin:32px auto;padding:0 20px}.card{background:#111827;border:1px solid #334155;border-radius:16px;padding:20px;margin:16px 0}input,textarea,button,select{font:inherit}input,textarea,select{width:100%;box-sizing:border-box;background:#020617;color:#e2e8f0;border:1px solid #475569;border-radius:10px;padding:10px;margin:6px 0 12px}textarea{min-height:140px}button{background:#38bdf8;border:0;color:#082f49;border-radius:10px;padding:10px 16px;font-weight:700;cursor:pointer}.muted{color:#94a3b8}.ok{color:#86efac}.err{color:#fca5a5}pre{white-space:pre-wrap;background:#020617;padding:12px;border-radius:10px;overflow:auto}.hidden{display:none}</style><main><h1>Agent Bridge</h1><p class="muted">同一个面板调度 TRAE SOLO CN 或 Codex。Trae 支持 work/code/design；Codex 支持 atoa（Agent-to-Agent）模式，后台执行并把结果写回项目目录。</p><div class="card"><label>项目目录</label><input id="project" placeholder="/Users/dadong/path/to/project"><label>Agent</label><select id="agent" onchange="agentChanged()"><option value="trae" selected>Trae Solo</option><option value="codex">Codex</option></select><div id="traeFields"><label>Solo 模式</label><select id="mode"><option value="work">work：PPT / Work</option><option value="code" selected>code：编程 / Code</option><option value="design">design：前端设计 / Design</option></select><label>会话</label><select id="sessionSelect"><option value="new:" selected>默认：新开会话</option></select><p class="muted" id="sessionHint">不选择真实会话时，默认新开会话。点击刷新会识别当前 Trae Solo 客户端会话/工作区。</p><p><button type="button" onclick="loadSessions()">刷新真实会话</button></p><label>传递方式</label><select id="transfer"><option value="cli" selected>CLI：打开项目并直接提交 prompt</option><option value="clipboard">剪贴板：只打开 App，手动粘贴</option></select><label>Trae Solo CLI 路径，可空</label><input id="cli" placeholder="/Applications/TRAE SOLO CN.app/Contents/Resources/app/bin/trae-solo-cn"></div><div id="codexFields" class="hidden"><label>Codex 模式</label><select id="codexMode"><option value="atoa" selected>atoa：Agent-to-Agent 协作</option></select><label>Codex CLI 路径，可空</label><input id="codexCli" placeholder="/Users/dadong/.local/bin/codex"><p class="muted">atoa 会用 <code>codex --cd 项目目录 --sandbox workspace-write --ask-for-approval never exec</code> 后台执行，输出写入项目内结果文件。</p></div><label>Prompt</label><textarea id="prompt" placeholder="让 Agent 做什么；Bridge 会自动追加结果文件路径和任务ID"></textarea><p><button onclick="launch()">提交任务</button></p><div id="launchOut" class="muted"></div></div><div class="card"><h2>运行记录</h2><div id="runs"></div></div></main><script>
function agentChanged(){ const a=agent.value; traeFields.classList.toggle('hidden',a!=='trae'); codexFields.classList.toggle('hidden',a!=='codex'); }
async function launch(){ const out=document.getElementById('launchOut'); const sessionEl=document.getElementById('sessionSelect'); out.textContent='处理中...'; const body={agent:agent.value,projectPath:project.value,prompt:prompt.value,mode:mode.value,codexMode:codexMode.value,sessionMode:(sessionEl.value.split(':')[0]||'new'),sessionId:sessionEl.value.split(':').slice(1).join(':')||undefined,transfer:transfer.value,cliPath:cli.value||undefined,codexCliPath:codexCli.value||undefined}; const r=await fetch('/api/launch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); const j=await r.json(); out.innerHTML=j.ok?'<span class="ok">已接受。Agent：'+(j.run.agent||'trae')+'，模式：'+j.run.mode+'，任务ID：'+j.run.id+'</span><p class="muted">'+(j.warning||j.run.warning||'请以客户端消息或结果文件为准。')+'</p><pre>'+JSON.stringify(j.run,null,2)+'</pre>':'<span class="err">提交失败：'+(j.error||j.run?.launched?.error||'unknown')+'</span><pre>'+JSON.stringify(j,null,2)+'</pre>'; loadRuns(); }
async function loadRuns(){ const j=await (await fetch('/api/runs')).json(); runs.innerHTML=j.runs.map(r=>'<div class="card"><b>'+r.id+'</b> <span class="muted">'+(r.agent||'trae')+' / '+(r.mode||'')+' / '+(r.sessionLabel||r.sessionMode||'')+'</span><br><span class="muted">'+r.projectPath+'</span><br><button data-run-id="'+r.id+'" onclick="result(this.dataset.runId)">检查结果</button><pre id="res-'+r.id+'"></pre></div>').join('')||'<p class="muted">暂无</p>'; }
async function result(id){ const j=await (await fetch('/api/result/'+id)).json(); document.getElementById('res-'+id).textContent=JSON.stringify(j,null,2); }
async function loadSessions(){ const j=await (await fetch('/api/sessions')).json(); const keep=sessionSelect.value; const esc=s=>String(s||'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c])); const val=s=>String(s||'').replace(/\"/g,'&quot;'); const groups={current:[],work:[],code:[],design:[],unknown:[],workspace:[]}; for(const s of (j.sessions||[])){ const submitMode=(s.kind==='current-chat'||s.kind==='chat')?'current':(s.kind==='current'?'current':'workspace'); const option='<option value="'+val(submitMode+':'+s.id)+'">'+esc(s.label)+(s.projectPath?' — '+esc(s.projectPath):'')+'</option>'; if(s.kind==='current-chat'||s.kind==='current') groups.current.push(option); else if(s.kind==='workspace') groups.workspace.push(option); else if(groups[s.mode]) groups[s.mode].push(option); else groups.unknown.push(option); } const opts=['<option value="new:">默认：新开会话</option>']; const addGroup=(label,arr)=>{ if(arr.length) opts.push('<optgroup label="'+esc(label)+'">'+arr.join('')+'</optgroup>'); }; addGroup('当前客户端',groups.current); addGroup('Work 会话',groups.work); addGroup('Code 会话',groups.code); addGroup('Design 会话',groups.design); addGroup('未知模式会话',groups.unknown); addGroup('工作区',groups.workspace); sessionSelect.innerHTML=opts.join(''); if([...sessionSelect.options].some(o=>o.value===keep)) sessionSelect.value=keep; sessionHint.textContent=(j.sessions&&j.sessions.length)?('已按 Work / Code / Design 分组识别 '+j.sessions.length+' 个真实会话/窗口/工作区。'):'暂未识别到真实会话；不选则默认新开。'; }
agentChanged(); loadSessions(); loadRuns();
</script>`;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
    if (req.method === "GET" && url.pathname === "/")
      return send(res, 200, html, "text/html");
    send(res, 404, "not found", "text/plain");
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});
server.listen(Number(PORT), HOST, () =>
  console.log(`Trae Solo Bridge listening on http://${HOST}:${PORT}`)
);
