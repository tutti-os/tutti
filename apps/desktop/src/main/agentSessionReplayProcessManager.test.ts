import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import test from "node:test";
import type { DesktopLogger } from "./logging.ts";
import { createAgentSessionReplayProcessManager } from "./agentSessionReplayProcessManager.ts";

test("resolves launch when the Session is visible and completion separately", async () => {
  const child = createChild();
  let invocation:
    | {
        args: readonly string[];
        command: string;
        options: {
          env: NodeJS.ProcessEnv;
        };
      }
    | undefined;
  const manager = createAgentSessionReplayProcessManager({
    electronEntry: "/repo/apps/desktop/out/main/index.js",
    electronExecutable: "/electron",
    environment: { ELECTRON_RENDERER_URL: "http://127.0.0.1:5173" },
    logger: createLogger(),
    nodeExecutable: "/node",
    repositoryRoot: "/repo",
    spawnProcess(command, args, options) {
      invocation = { args, command, options };
      const runId = args[args.indexOf("--run-id") + 1];
      queueMicrotask(() => {
        child.stdout.write(
          `[tutti-agent-session-replay-ready] ${JSON.stringify({ runId })}\n`
        );
      });
      return child;
    }
  });

  const result = await manager.launch({
    cassetteId: "cassette-1",
    cassetteDirectory: "/cassette",
    runId: "replay-run-1",
    workspaceId: "workspace-1"
  });

  assert.equal(invocation?.command, "/node");
  assert.deepEqual(invocation?.args.slice(1, 4), [
    "--replay",
    "/cassette",
    "--managed"
  ]);
  assert.equal(
    invocation?.options.env?.TUTTI_AGENT_SESSION_REPLAY_ELECTRON_EXECUTABLE,
    "/electron"
  );
  assert.equal(
    invocation?.options.env?.TUTTI_AGENT_SESSION_REPLAY_ELECTRON_ENTRY,
    "/repo/apps/desktop/out/main/index.js"
  );
  assert.equal(
    invocation?.options.env?.ELECTRON_RENDERER_URL,
    "http://127.0.0.1:5173"
  );
  assert.equal(result.runId, "replay-run-1");
  let completed = false;
  const completion = manager
    .waitForCompletion({ runId: "replay-run-1" })
    .then(() => {
      completed = true;
    });
  await Promise.resolve();
  assert.equal(completed, false);

  child.stdout.write(
    `[tutti-agent-session-replay-complete] ${JSON.stringify({
      runId: "replay-run-1"
    })}\n`
  );
  await completion;
  assert.equal(completed, true);

  manager.dispose();
  assert.equal(child.killed, true);
});

test("rejects when replay validation fails before ready", async () => {
  const child = createChild();
  const manager = createAgentSessionReplayProcessManager({
    electronExecutable: "/electron",
    logger: createLogger(),
    nodeExecutable: "/node",
    repositoryRoot: "/repo",
    spawnProcess() {
      queueMicrotask(() => {
        child.stderr.write("process cassette outbound mismatch");
        child.emit("exit", 1, null);
      });
      return child;
    }
  });

  await assert.rejects(
    manager.launch({
      cassetteId: "cassette-1",
      cassetteDirectory: "/cassette",
      runId: "replay-run-1",
      workspaceId: "workspace-1"
    }),
    /process cassette outbound mismatch/
  );
  assert.equal(child.killed, true);
});

test("keeps a failed replay window available for restart", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "replay-failed-"));
  const children = [createChild(), createChild()];
  const requests: string[] = [];
  let invocation = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (resource) => {
    const path = new URL(String(resource)).pathname;
    requests.push(path);
    if (path.endsWith("/agent-session-cassettes")) {
      return Response.json({
        cassettes: [{ id: "cassette-1", name: "One" }]
      });
    }
    if (path.endsWith("/replay-runs")) {
      return Response.json(
        {
          cassetteDirectory: "/cassette/restarted",
          run: { id: "replay-run-2" }
        },
        { status: 201 }
      );
    }
    return Response.json({});
  }) as typeof globalThis.fetch;
  const manager = createAgentSessionReplayProcessManager({
    electronExecutable: "/electron",
    endpoint: {
      accessToken: "primary-secret",
      boundAddr: "127.0.0.1:1234",
      listenerInfoPath: "/tmp/listener.json",
      pidPath: "/tmp/tuttid.pid",
      requestedAddr: "127.0.0.1:0"
    },
    logger: createLogger(),
    nodeExecutable: "/node",
    repositoryRoot: "/repo",
    spawnProcess(_command, args) {
      const child = children[invocation]!;
      invocation += 1;
      const runId = args[args.indexOf("--run-id") + 1];
      queueMicrotask(() => {
        child.stdout.write(
          `[tutti-agent-session-replay-ready] ${JSON.stringify({
            runId,
            runtimeDirectory
          })}\n`
        );
      });
      return child;
    }
  });
  try {
    await manager.launch({
      cassetteId: "cassette-1",
      cassetteDirectory: "/cassette",
      runId: "replay-run-1",
      workspaceId: "workspace-1"
    });
    const completion = manager.waitForCompletion({ runId: "replay-run-1" });

    children[0]!.stdout.write(
      `[tutti-agent-session-replay-failed] ${JSON.stringify({
        error: "expected state mismatch",
        runId: "replay-run-1"
      })}\n`
    );

    await assert.rejects(completion, /expected state mismatch/u);
    assert.equal(children[0]!.killed, false);
    children[0]!.stdout.write(
      `[tutti-agent-session-replay-replace] ${JSON.stringify({
        command: "restart",
        currentCheckpoint: 3,
        runId: "replay-run-1"
      })}\n`
    );
    await Promise.resolve();
    assert.equal(invocation, 1);
    assert.equal(children[0]!.killed, false);
    children[0]!.emit("exit", 0, null);
    await waitFor(() => invocation === 2);
    children[1]!.stdout.write(
      `[tutti-agent-session-replay-complete] ${JSON.stringify({
        runId: "replay-run-2"
      })}\n`
    );
    await waitFor(() =>
      requests.some((path) => path.endsWith("/replay-run-2/complete"))
    );
  } finally {
    manager.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("replaces a Run for previous checkpoint and completes the latest Run", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "replay-supervisor-"));
  const children = [createChild(), createChild(), createChild()];
  const invocations: string[][] = [];
  const requests: Array<{ body?: unknown; path: string }> = [];
  let preparedRuns = 1;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (resource, init) => {
    const url = String(resource);
    const path = new URL(url).pathname;
    requests.push({
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) }
        : {}),
      path
    });
    if (path.endsWith("/agent-session-cassettes")) {
      return Response.json({
        cassettes: [{ id: "cassette-1", name: "One" }]
      });
    }
    if (path.endsWith("/replay-runs")) {
      preparedRuns += 1;
      return Response.json(
        {
          cassetteDirectory: "/cassette/replacement",
          run: { id: `replay-run-${preparedRuns}` }
        },
        { status: 201 }
      );
    }
    return Response.json({});
  }) as typeof globalThis.fetch;
  try {
    const manager = createAgentSessionReplayProcessManager({
      electronExecutable: "/electron",
      endpoint: {
        accessToken: "primary-secret",
        boundAddr: "127.0.0.1:1234",
        listenerInfoPath: "/tmp/listener.json",
        pidPath: "/tmp/tuttid.pid",
        requestedAddr: "127.0.0.1:0"
      },
      logger: createLogger(),
      nodeExecutable: "/node",
      repositoryRoot: "/repo",
      spawnProcess(_command, args, options) {
        assert.equal(
          options.env.TUTTID_ACCESS_TOKEN,
          undefined,
          "primary daemon token must not enter the isolated runtime"
        );
        invocations.push([...args]);
        const child = children[invocations.length - 1]!;
        const runId = args[args.indexOf("--run-id") + 1];
        queueMicrotask(() => {
          child.stdout.write(
            `[tutti-agent-session-replay-ready] ${JSON.stringify({
              runId,
              runtimeDirectory
            })}\n`
          );
        });
        return child;
      }
    });
    await manager.launch({
      cassetteId: "cassette-1",
      cassetteDirectory: "/cassette/original",
      runId: "replay-run-1",
      workspaceId: "workspace-1"
    });
    const completion = manager.waitForCompletion({ runId: "replay-run-1" });
    children[0]!.stdout.write(
      `[tutti-agent-session-replay-checkpoint] ${JSON.stringify({
        checkpoint: 2,
        runId: "replay-run-1"
      })}\n`
    );
    children[0]!.stdout.write(
      `[tutti-agent-session-replay-replace] ${JSON.stringify({
        command: "previous-checkpoint",
        currentCheckpoint: 2,
        runId: "replay-run-1"
      })}\n`
    );
    await Promise.resolve();
    assert.equal(invocations.length, 1);
    assert.equal(children[0]!.killed, false);
    children[0]!.emit("exit", 0, null);
    await waitFor(() => invocations.length === 2);
    assert.deepEqual(invocations[1]!.slice(-2), ["--target-checkpoint", "1"]);
    children[1]!.stdout.write(
      `[tutti-agent-session-replay-complete] ${JSON.stringify({
        runId: "replay-run-2"
      })}\n`
    );
    assert.deepEqual(await completion, { runId: "replay-run-2" });
    assert.deepEqual(
      requests
        .filter(({ path }) => !path.endsWith("/agent-session-cassettes"))
        .map(({ body, path }) => ({ body, path })),
      [
        {
          body: { checkpoint: 2 },
          path: "/v1/workspaces/workspace-1/agent-session-replay-runs/replay-run-1/checkpoint"
        },
        {
          body: undefined,
          path: "/v1/workspaces/workspace-1/agent-session-replay-runs/replay-run-1/cancel"
        },
        {
          body: undefined,
          path: "/v1/workspaces/workspace-1/agent-session-cassettes/cassette-1/replay-runs"
        },
        {
          body: undefined,
          path: "/v1/workspaces/workspace-1/agent-session-replay-runs/replay-run-2/running"
        }
      ]
    );
    children[1]!.stdout.write(
      `[tutti-agent-session-replay-replace] ${JSON.stringify({
        command: "restart",
        currentCheckpoint: 2,
        runId: "replay-run-2"
      })}\n`
    );
    await Promise.resolve();
    assert.equal(invocations.length, 2);
    assert.equal(children[1]!.killed, false);
    children[1]!.emit("exit", 0, null);
    await waitFor(() => invocations.length === 3);
    children[2]!.stdout.write(
      `[tutti-agent-session-replay-complete] ${JSON.stringify({
        runId: "replay-run-3"
      })}\n`
    );
    await waitFor(() =>
      requests.some(({ path }) => path.endsWith("/replay-run-3/complete"))
    );
    assert.equal(
      requests.some(({ path }) => path.endsWith("/replay-run-2/cancel")),
      false
    );
    manager.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createChild() {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    killed: boolean;
    kill(signal?: NodeJS.Signals): boolean;
    signalCode: NodeJS.Signals | null;
    stderr: PassThrough;
    stdout: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

function createLogger(): DesktopLogger {
  return {
    async close() {},
    debug() {},
    error() {},
    info() {},
    warn() {}
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}
