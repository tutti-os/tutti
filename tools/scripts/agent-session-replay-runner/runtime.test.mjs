import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveHostAccountAuthPath,
  seedHostAccountSession
} from "./runtime.mjs";

test("resolveHostAccountAuthPath defaults to ~/.tutti-dev account session", () => {
  assert.equal(
    resolveHostAccountAuthPath({}, "/Users/ryan"),
    join("/Users/ryan", ".tutti-dev", "account", "auth.json")
  );
});

test("resolveHostAccountAuthPath honors explicit override", () => {
  assert.equal(
    resolveHostAccountAuthPath(
      {
        TUTTI_AGENT_SESSION_REPLAY_HOST_ACCOUNT_AUTH: " /tmp/custom-auth.json "
      },
      "/Users/ryan"
    ),
    "/tmp/custom-auth.json"
  );
});

test("seedHostAccountSession copies a valid host login into isolated state", async () => {
  const root = await mkdtemp(join(tmpdir(), "replay-host-account-"));
  try {
    const home = join(root, "home");
    const sourceDir = join(home, ".tutti-dev", "account");
    await mkdir(sourceDir, { recursive: true });
    const session = {
      session_id: "session-1",
      cookie: "session_id=session-1",
      email: "ryan@example.com",
      name: "ryan"
    };
    await writeFile(join(sourceDir, "auth.json"), JSON.stringify(session));

    const stateDirectory = join(root, "state");
    const result = await seedHostAccountSession(stateDirectory, {
      env: {},
      homeDirectory: home
    });

    assert.equal(result.action, "copied");
    const copied = JSON.parse(
      await readFile(join(stateDirectory, "account", "auth.json"), "utf8")
    );
    assert.equal(copied.session_id, "session-1");
    assert.equal(copied.cookie, "session_id=session-1");
    assert.equal(copied.email, "ryan@example.com");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("seedHostAccountSession skips when host login is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "replay-host-account-missing-"));
  try {
    const result = await seedHostAccountSession(join(root, "state"), {
      env: {},
      homeDirectory: join(root, "empty-home")
    });
    assert.equal(result.action, "skipped-missing");
    await assert.rejects(access(join(root, "state", "account", "auth.json")));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("seedHostAccountSession skips invalid host login payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "replay-host-account-invalid-"));
  try {
    const home = join(root, "home");
    const sourceDir = join(home, ".tutti-dev", "account");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "auth.json"),
      JSON.stringify({ name: "x" })
    );

    const result = await seedHostAccountSession(join(root, "state"), {
      env: {},
      homeDirectory: home
    });
    assert.equal(result.action, "skipped-invalid");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("seedHostAccountSession can be disabled via env", async () => {
  const root = await mkdtemp(join(tmpdir(), "replay-host-account-skip-"));
  try {
    const home = join(root, "home");
    const sourceDir = join(home, ".tutti-dev", "account");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "auth.json"),
      JSON.stringify({
        session_id: "session-1",
        cookie: "session_id=session-1"
      })
    );

    const result = await seedHostAccountSession(join(root, "state"), {
      env: { TUTTI_AGENT_SESSION_REPLAY_SKIP_HOST_ACCOUNT_AUTH: "1" },
      homeDirectory: home
    });
    assert.equal(result.action, "skipped-disabled");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
