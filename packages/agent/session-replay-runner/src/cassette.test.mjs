import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import {
  createCassetteHelpers,
  parseActivityEvents,
  portableReplayCWDToken,
  replayTurnIdentityPlan,
  validComposerDefaultsPrerequisites,
  verifyCassette
} from "./cassette.mjs";
import { loadCassettePolicy } from "./cassette-policy.mjs";

const cassettePolicyPath = fileURLToPath(
  new URL("../../session-replay/cassette-policy.json", import.meta.url)
);

test("createCassetteHelpers binds verify/parse against Tutti policy", async () => {
  const policy = await loadCassettePolicy(cassettePolicyPath);
  const helpers = createCassetteHelpers(policy, {
    canonicalizeResolvedPaths: true
  });
  const root = await mkdtemp(join(tmpdir(), "shared-cassette-"));
  const cassette = join(root, "cassette");
  await writeValidCassette(cassette, policy);
  const manifest = await helpers.verifyCassette(cassette);
  assert.equal(manifest.schemaVersion, policy.schemaVersion);
  assert.equal(helpers.parseActivityEvents("").length, 0);
  assert.equal(portableReplayCWDToken, "${REPLAY_CWD}");
});

test("verifyCassette rejects unrelated inventory files", async () => {
  const policy = await loadCassettePolicy(cassettePolicyPath);
  const root = await mkdtemp(join(tmpdir(), "shared-cassette-unrelated-"));
  const cassette = join(root, "cassette");
  await writeValidCassette(cassette, policy);
  await writeFile(join(cassette, "debug.log"), "nope");
  await assert.rejects(verifyCassette(cassette, policy), /unrelated file/u);
});

test("parseActivityEvents requires monotonic sequences", async () => {
  const policy = await loadCassettePolicy(cassettePolicyPath);
  assert.throws(
    () =>
      parseActivityEvents(
        JSON.stringify({
          schemaVersion: policy.schemaVersion,
          sequence: 2,
          kind: "intent",
          type: "activation/requested",
          eventId: "a",
          occurredAtUnixMs: 1,
          payload: {}
        }),
        policy
      ),
    /invalid/u
  );
});

test("validComposerDefaultsPrerequisites is the default gate", () => {
  assert.equal(
    validComposerDefaultsPrerequisites({
      composerDefaults: {
        model: "m",
        permissionModeId: "p",
        reasoningEffort: "r",
        speed: "s"
      }
    }),
    true
  );
  assert.equal(validComposerDefaultsPrerequisites({}), false);
});

test("replayTurnIdentityPlan subtracts initial turns", () => {
  const plan = replayTurnIdentityPlan(
    {
      agent: {
        sessions: [
          {
            id: "s1",
            turns: [{ id: "t0" }, { id: "t1" }]
          }
        ]
      }
    },
    {
      agent: {
        sessions: [{ id: "s1", turns: [{ id: "t0" }] }]
      }
    }
  );
  assert.deepEqual(plan.s1.initialTurnIds, ["t0"]);
  assert.deepEqual(plan.s1.recordedTurnIds, ["t1"]);
});

test("requireManifestIdentity rejects missing id", async () => {
  const policy = await loadCassettePolicy(cassettePolicyPath);
  const root = await mkdtemp(join(tmpdir(), "shared-cassette-id-"));
  const cassette = join(root, "cassette");
  await writeValidCassette(cassette, policy, { omitId: true });
  await assert.rejects(
    verifyCassette(cassette, policy, { requireManifestIdentity: true }),
    /invalid or unsupported/u
  );
});

async function writeValidCassette(cassette, policy, options = {}) {
  await mkdir(cassette, { recursive: true });
  const contents = new Map();
  for (const file of Object.values(policy.files)) {
    if (!file.required || file.inventory === false) continue;
    contents.set(
      file.path,
      file.path === policy.files.blobManifest.path
        ? JSON.stringify({
            schemaVersion: policy.blobManifestSchemaVersion,
            blobs: []
          })
        : ""
    );
  }
  const files = [];
  let totalBytes = 0;
  for (const [path, content] of contents) {
    const absolute = join(cassette, ...path.split("/"));
    await mkdir(dirname(absolute), { recursive: true });
    const bytes = Buffer.from(content);
    await writeFile(absolute, bytes);
    const policyFile = Object.values(policy.files).find(
      (file) => file.path === path
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    files.push({
      path,
      role: policyFile.role,
      sizeBytes: bytes.byteLength,
      sha256
    });
    totalBytes += bytes.byteLength;
  }
  const manifest = {
    schemaVersion: policy.schemaVersion,
    stateFormat: "tutti.agent-session-replay-state.v1",
    mode: "create-session",
    agentTargetId: "local:codex",
    rootAgentSessionId: "session-1",
    replayPrerequisites: {
      composerDefaults: {
        model: "m",
        permissionModeId: "p",
        reasoningEffort: "r",
        speed: "s"
      }
    },
    maxTotalBytes: policy.limits.maxCassetteBytes,
    totalBytes,
    files
  };
  if (!options.omitId) {
    manifest.id = "cassette-1";
  }
  await writeFile(
    join(cassette, policy.files.cassetteManifest.path),
    JSON.stringify(manifest)
  );
}
