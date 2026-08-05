import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireAgentSessionReplayProjectRoot } from "./project-root.mjs";

const projectRootEnvironment = "TUTTI_AGENT_SESSION_REPLAY_PROJECT_ROOT";

test("acquires and removes a run-scoped temporary Git project", async () => {
  const previous = process.env[projectRootEnvironment];
  delete process.env[projectRootEnvironment];
  let project;
  try {
    project = await acquireAgentSessionReplayProjectRoot();
    const root = project.root;
    assert.equal(project.owned, true);
    assert.equal(process.env[projectRootEnvironment], root);
    assert.equal(
      root.startsWith(join(tmpdir(), "tutti-agent-session-rec-")),
      true
    );
    await access(join(root, ".git"));
    assert.match(
      await readFile(join(root, "README.md"), "utf8"),
      /outside the product checkout/u
    );

    await project.dispose();
    project = undefined;
    await assert.rejects(access(root));
  } finally {
    await project?.dispose();
    restoreProjectRootEnvironment(previous);
  }
});

test("keep-runtime retains an owned temporary project", async () => {
  const previous = process.env[projectRootEnvironment];
  delete process.env[projectRootEnvironment];
  let project;
  try {
    project = await acquireAgentSessionReplayProjectRoot({ keepRuntime: true });
    await project.dispose();
    await access(join(project.root, ".git"));
  } finally {
    if (project?.root) {
      await rm(project.root, { force: true, recursive: true });
    }
    restoreProjectRootEnvironment(previous);
  }
});

test("preserves an externally supplied project root", async () => {
  const previous = process.env[projectRootEnvironment];
  const parent = await mkdtemp(
    join(tmpdir(), "tutti-session-replay-external-")
  );
  const externalRoot = join(parent, "project");
  process.env[projectRootEnvironment] = externalRoot;
  try {
    const project = await acquireAgentSessionReplayProjectRoot();
    assert.equal(project.owned, false);
    assert.equal(project.root, externalRoot);
    await writeFile(join(project.root, "marker.txt"), "preserve\n");
    await project.dispose();
    assert.equal(
      await readFile(join(project.root, "marker.txt"), "utf8"),
      "preserve\n"
    );
    assert.equal(process.env[projectRootEnvironment], externalRoot);
  } finally {
    restoreProjectRootEnvironment(previous);
    await rm(parent, { force: true, recursive: true });
  }
});

function restoreProjectRootEnvironment(previous) {
  if (previous === undefined) {
    delete process.env[projectRootEnvironment];
  } else {
    process.env[projectRootEnvironment] = previous;
  }
}
