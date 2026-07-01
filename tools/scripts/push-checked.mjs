import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const cliArgs =
  process.argv[2] === "--" ? process.argv.slice(3) : process.argv.slice(2);
const dryRun = cliArgs.includes("--dry-run");

if (cliArgs.some((arg) => arg !== "--dry-run")) {
  fail("usage: pnpm push:checked [-- --dry-run]");
}

const branch = gitOutput(["branch", "--show-current"]);
if (!branch) {
  fail("push:checked requires a named current branch");
}

if (dryRun) {
  warnIfDirtyWorktree();
} else {
  assertCleanWorktree();
}

const remote = branchConfig("remote") ?? "origin";
if (remote === ".") {
  fail("push:checked does not support local-dot branch remotes");
}

const remoteBranch = normalizeMergeRef(branchConfig("merge")) ?? branch;
const remoteRef = `refs/remotes/${remote}/${remoteBranch}`;
const pushRef = `refs/heads/${remoteBranch}`;

console.log(`push:checked branch ${branch}`);
console.log(`push:checked remote ${remote}/${remoteBranch}`);

const remoteHead = lsRemoteHead(remote, remoteBranch);
if (remoteHead) {
  run("git", ["fetch", "--no-tags", remote, `+${pushRef}:${remoteRef}`]);
  assertRemoteHasNoNewCommits(remoteRef);
} else {
  console.log("push:checked remote branch does not exist yet");
}

if (dryRun) {
  console.log("push:checked dry run: would run pnpm check:full");
  console.log(
    `push:checked dry run: would push HEAD to ${remote}/${remoteBranch}`
  );
  process.exit(0);
}

run(pnpmCommand, ["run", "check:full"], { stdio: "inherit" });

const lease = `--force-with-lease=${pushRef}:${remoteHead ?? ""}`;
run("git", ["push", lease, "--set-upstream", remote, `HEAD:${pushRef}`], {
  env: { ...process.env, HUSKY: "0" },
  stdio: "inherit"
});

console.log("push:checked pushed");

function branchConfig(key) {
  const value = gitOutput(["config", `branch.${branch}.${key}`], {
    allowFailure: true
  });
  return value || null;
}

function normalizeMergeRef(value) {
  if (!value) {
    return null;
  }
  const prefix = "refs/heads/";
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function lsRemoteHead(remoteName, branchName) {
  const result = spawnSync(
    "git",
    ["ls-remote", "--heads", remoteName, branchName],
    {
      cwd: workspaceRoot,
      encoding: "utf8"
    }
  );

  if (result.status !== 0) {
    if (result.stderr.trim()) {
      process.stderr.write(result.stderr);
    }
    fail(`failed to inspect ${remoteName}/${branchName}`);
  }

  const firstLine = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine?.split(/\s+/u)[0] ?? null;
}

function assertRemoteHasNoNewCommits(ref) {
  const counts = gitOutput([
    "rev-list",
    "--left-right",
    "--count",
    `HEAD...${ref}`
  ])
    .split(/\s+/u)
    .map((value) => Number.parseInt(value, 10));
  const [ahead, behind] = counts;
  if (behind === 0) {
    console.log(`push:checked local ahead ${ahead}`);
    return;
  }

  const remoteCommits = gitOutput(["log", "--oneline", `HEAD..${ref}`], {
    allowFailure: true
  });
  if (remoteCommits) {
    process.stderr.write(`remote has new commit(s):\n${remoteCommits}\n`);
  }
  fail("fetch/rebase before running check:full");
}

function assertCleanWorktree() {
  const status = gitOutput(["status", "--porcelain"]);
  if (!status) {
    return;
  }
  process.stderr.write(`${status}\n`);
  fail("commit or stash local changes before push:checked");
}

function warnIfDirtyWorktree() {
  const status = gitOutput(["status", "--porcelain"]);
  if (status) {
    process.stderr.write(
      "push:checked dry run: real push requires clean worktree\n"
    );
  }
}

function gitOutput(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    if (options.allowFailure) {
      return "";
    }
    if (result.stderr.trim()) {
      process.stderr.write(result.stderr);
    }
    fail(`git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit"
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed`);
  }
}

function fail(message) {
  process.stderr.write(`push:checked: ${message}\n`);
  process.exit(1);
}
