import assert from "node:assert/strict";
import test from "node:test";

import { createDmgArtifactNotarizer } from "../../apps/desktop/scripts/notarize-mac-dmg-artifacts.mjs";

test("desktop DMG notarization retries transient notarytool submit failures", async () => {
  const calls = [];
  const notarizeMacDmgArtifacts = createDmgArtifactNotarizer({
    env: {
      APPLE_API_KEY: "/tmp/AuthKey_TEST.p8",
      APPLE_API_KEY_ID: "TESTKEY",
      APPLE_API_ISSUER: "TESTISSUER"
    },
    logger: {
      error() {},
      log() {}
    },
    maxSubmitAttempts: 2,
    platform: "darwin",
    retryDelayMs: 0,
    runCommand: async (command, args) => {
      calls.push([command, args]);

      if (args[0] === "notarytool" && args[1] === "submit") {
        const submitAttempts = calls.filter(
          ([, callArgs]) =>
            callArgs[0] === "notarytool" && callArgs[1] === "submit"
        ).length;

        if (submitAttempts === 1) {
          const error = new Error("notary service temporarily unavailable");
          error.stderr = "The Apple notary service is temporarily unavailable.";
          throw error;
        }
      }

      return { stderr: "", stdout: "" };
    }
  });

  await notarizeMacDmgArtifacts({
    artifactPaths: ["/tmp/Tutti-0.0.2-rc.17-mac-universal.dmg"]
  });

  const submitCalls = calls.filter(
    ([, args]) => args[0] === "notarytool" && args[1] === "submit"
  );
  const stapleCalls = calls.filter(
    ([, args]) => args[0] === "stapler" && args[1] === "staple"
  );

  assert.equal(submitCalls.length, 2);
  assert.equal(stapleCalls.length, 1);
});

test("desktop DMG notarization fetches logs for invalid submissions without retrying", async () => {
  const calls = [];
  const notarizeMacDmgArtifacts = createDmgArtifactNotarizer({
    env: {
      APPLE_API_KEY: "/tmp/AuthKey_TEST.p8",
      APPLE_API_KEY_ID: "TESTKEY",
      APPLE_API_ISSUER: "TESTISSUER"
    },
    logger: {
      error() {},
      log() {}
    },
    maxSubmitAttempts: 3,
    platform: "darwin",
    retryDelayMs: 0,
    runCommand: async (command, args) => {
      calls.push([command, args]);

      if (args[0] === "notarytool" && args[1] === "submit") {
        const error = new Error("notary submission invalid");
        error.stdout = JSON.stringify({
          id: "submission-id",
          status: "Invalid"
        });
        throw error;
      }

      return { stderr: "", stdout: "" };
    }
  });

  await assert.rejects(
    notarizeMacDmgArtifacts({
      artifactPaths: ["/tmp/Tutti-0.0.2-rc.17-mac-universal.dmg"]
    }),
    /notary submission invalid/
  );

  const submitCalls = calls.filter(
    ([, args]) => args[0] === "notarytool" && args[1] === "submit"
  );
  const logCalls = calls.filter(
    ([, args]) => args[0] === "notarytool" && args[1] === "log"
  );

  assert.equal(submitCalls.length, 1);
  assert.equal(logCalls.length, 1);
  assert.equal(logCalls[0][1][2], "submission-id");
});

test("desktop DMG notarization submits multiple artifacts concurrently", async () => {
  let activeSubmits = 0;
  let maxConcurrentSubmits = 0;
  const calls = [];
  const notarizeMacDmgArtifacts = createDmgArtifactNotarizer({
    env: {
      APPLE_API_KEY: "/tmp/AuthKey_TEST.p8",
      APPLE_API_KEY_ID: "TESTKEY",
      APPLE_API_ISSUER: "TESTISSUER"
    },
    logger: {
      error() {},
      log() {}
    },
    platform: "darwin",
    runCommand: async (command, args) => {
      calls.push([command, args]);

      if (args[0] === "notarytool" && args[1] === "submit") {
        activeSubmits += 1;
        maxConcurrentSubmits = Math.max(maxConcurrentSubmits, activeSubmits);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeSubmits -= 1;
      }

      return { stderr: "", stdout: "" };
    }
  });

  await notarizeMacDmgArtifacts({
    artifactPaths: [
      "/tmp/Tutti-0.0.2-rc.17-mac-x64.dmg",
      "/tmp/Tutti-0.0.2-rc.17-mac-arm64.dmg",
      "/tmp/Tutti-0.0.2-rc.17-mac-universal.dmg"
    ]
  });

  const submitCalls = calls.filter(
    ([, args]) => args[0] === "notarytool" && args[1] === "submit"
  );
  const stapleCalls = calls.filter(
    ([, args]) => args[0] === "stapler" && args[1] === "staple"
  );

  assert.equal(submitCalls.length, 3);
  assert.equal(stapleCalls.length, 3);
  assert.ok(
    maxConcurrentSubmits > 1,
    `expected concurrent notary submissions, got max concurrency ${maxConcurrentSubmits}`
  );
});
