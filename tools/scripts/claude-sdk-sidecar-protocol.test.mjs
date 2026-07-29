import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sidecarProtocolPath = new URL(
  "../../packages/agent/claude-sdk-sidecar/src/protocol.ts",
  import.meta.url
);
const daemonProtocolPath = new URL(
  "../../packages/agent/daemon/runtime/claude_sdk_protocol.go",
  import.meta.url
);
const releaseSmokePath = new URL(
  "../../apps/desktop/scripts/smoke-claude-sdk-sidecar.mjs",
  import.meta.url
);

test("Claude SDK sidecar protocol versions stay aligned across runtimes", async () => {
  const [sidecarProtocol, daemonProtocol, releaseSmoke] = await Promise.all([
    readFile(sidecarProtocolPath, "utf8"),
    readFile(daemonProtocolPath, "utf8"),
    readFile(releaseSmokePath, "utf8")
  ]);

  const versions = {
    sidecar: extractProtocolVersion(
      sidecarProtocol,
      /CLAUDE_SDK_SIDECAR_PROTOCOL_VERSION\s*=\s*(\d+)\s+as const/u,
      "TypeScript sidecar"
    ),
    daemon: extractProtocolVersion(
      daemonProtocol,
      /claudeSDKSidecarProtocolVersion\s*=\s*(\d+)/u,
      "Go daemon"
    ),
    releaseSmoke: extractProtocolVersion(
      releaseSmoke,
      /JSON\.stringify\(\{\s*version:\s*(\d+),\s*\.\.\.request\s*\}\)/u,
      "desktop release smoke test"
    )
  };

  assert.equal(
    versions.daemon,
    versions.sidecar,
    `Go daemon protocol v${versions.daemon} must match TypeScript sidecar protocol v${versions.sidecar}`
  );
  assert.equal(
    versions.releaseSmoke,
    versions.sidecar,
    `desktop release smoke protocol v${versions.releaseSmoke} must match TypeScript sidecar protocol v${versions.sidecar}`
  );
});

function extractProtocolVersion(source, pattern, label) {
  const match = pattern.exec(source);
  assert.ok(match, `${label} must declare an explicit protocol version`);
  return Number(match[1]);
}
