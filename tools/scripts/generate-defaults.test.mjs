import assert from "node:assert/strict";
import test from "node:test";
import { format } from "prettier";

import { renderGoDefaults, renderTSDefaults } from "./generate-defaults.mjs";
import prettierConfig from "../../packages/configs/prettier/base.mjs";

test("renderTSDefaults produces prettier-stable TypeScript output", async () => {
  const rendered = await renderTSDefaults({
    state: {
      productionDirName: ".tutti",
      developmentDirName: ".tutti-dev"
    },
    transport: {
      defaultTCPAddr: "127.0.0.1:4545"
    },
    logging: {
      defaultLevel: "info",
      maxSizeMB: 50
    }
  });

  const reformatted = await format(rendered, {
    ...prettierConfig,
    parser: "typescript"
  });

  assert.equal(rendered, reformatted);
  assert.match(rendered, /state: {/);
  assert.doesNotMatch(rendered, /"state": {/);
});

test("renderGoDefaults produces gofmt-stable Go output", () => {
  const rendered = renderGoDefaults({
    state: {
      productionDirName: ".tutti",
      developmentDirName: ".tutti-dev",
      runDirName: "run",
      logsDirName: "logs",
      dbFileName: "tuttid.db",
      daemonLogFileName: "tuttid.log",
      desktopLogFileName: "tutti-desktop.log",
      listenerInfoFileName: "tuttid.listener.json",
      pidFileName: "tuttid.pid"
    },
    transport: {
      defaultTCPAddr: "127.0.0.1:4545"
    },
    logging: {
      defaultLevel: "info",
      defaultOutput: "file",
      maxSizeMB: 50,
      maxBackups: 10,
      maxAgeDays: 14,
      maxTotalMB: 300
    },
    analytics: {
      appId: 20004092,
      appKey: "app-key",
      channel: "sg",
      channelDomain: "https://gator.uba.ap-southeast-1.volces.com",
      appVersion: "0.0.0"
    }
  });

  assert.match(rendered, /\t\tProductionDirName:\s{4}".tutti",/);
  assert.match(rendered, /var generatedDefaults = generatedDefaultsSpec{/);
});

test("renderGoDefaults includes analytics defaults", () => {
  const rendered = renderGoDefaults({
    state: {
      productionDirName: ".tutti",
      developmentDirName: ".tutti-dev",
      runDirName: "run",
      logsDirName: "logs",
      dbFileName: "tuttid.db",
      daemonLogFileName: "tuttid.log",
      desktopLogFileName: "tutti-desktop.log",
      listenerInfoFileName: "tuttid.listener.json",
      pidFileName: "tuttid.pid"
    },
    transport: {
      defaultTCPAddr: "127.0.0.1:4545"
    },
    logging: {
      defaultLevel: "info",
      defaultOutput: "file",
      maxSizeMB: 50,
      maxBackups: 10,
      maxAgeDays: 14,
      maxTotalMB: 300
    },
    analytics: {
      appId: 20004092,
      appKey: "app-key",
      channel: "sg",
      channelDomain: "https://gator.uba.ap-southeast-1.volces.com",
      appVersion: "0.0.0"
    }
  });

  assert.match(rendered, /Analytics: generatedAnalyticsDefaults{/);
  assert.match(rendered, /AppID:\s+20004092,/);
  assert.match(rendered, /AppVersion:\s+"0.0.0",/);
});

const minimalSpec = {
  state: {
    productionDirName: ".tutti",
    developmentDirName: ".tutti-dev",
    runDirName: "run",
    logsDirName: "logs",
    dbFileName: "tuttid.db",
    daemonLogFileName: "tuttid.log",
    desktopLogFileName: "tutti-desktop.log",
    listenerInfoFileName: "tuttid.listener.json",
    pidFileName: "tuttid.pid"
  },
  transport: {
    defaultTCPAddr: "127.0.0.1:4545"
  },
  logging: {
    defaultLevel: "info",
    defaultOutput: "file",
    maxSizeMB: 50,
    maxBackups: 10,
    maxAgeDays: 14,
    maxTotalMB: 300
  },
  analytics: {
    appId: 20004092,
    appKey: "app-key",
    channel: "sg",
    channelDomain: "https://gator.uba.ap-southeast-1.volces.com",
    appVersion: "0.0.0"
  }
};

test("renderGoDefaults renders agentRuntimeTools.uv artifacts", () => {
  const rendered = renderGoDefaults({
    ...minimalSpec,
    agentRuntimeTools: {
      uv: {
        version: "0.11.31",
        artifacts: [
          {
            platform: "darwin-arm64",
            url: "https://example.com/uv.tar.gz",
            sha256:
              "b2b93e82a6786f9c7cb89fd4ca0e859a147b292ae8f6f95784f9742f0efec39e",
            sizeBytes: 22411216,
            archive: "tar.gz",
            archiveExecutable: "uv-aarch64-apple-darwin/uv"
          }
        ]
      }
    }
  });

  assert.match(
    rendered,
    /AgentRuntimeTools: generatedAgentRuntimeToolDefaults{/
  );
  assert.match(rendered, /UV: generatedUVToolDefaults{/);
  assert.match(rendered, /Version:\s+"0.11.31",/);
  assert.match(rendered, /Platform:\s+"darwin-arm64",/);
  assert.match(rendered, /SizeBytes:\s+22411216,/);
  assert.match(rendered, /ArchiveExecutable:\s+"uv-aarch64-apple-darwin\/uv",/);
});

test("renderGoDefaults tolerates a missing agentRuntimeTools section", () => {
  const rendered = renderGoDefaults(minimalSpec);

  assert.match(
    rendered,
    /AgentRuntimeTools: generatedAgentRuntimeToolDefaults{/
  );
  assert.match(rendered, /Version:\s+"",/);
});
