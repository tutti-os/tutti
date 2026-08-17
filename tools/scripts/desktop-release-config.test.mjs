import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

const desktopPackagePath = new URL(
  "../../apps/desktop/package.json",
  import.meta.url
);
const workspaceRootPackagePath = new URL("../../package.json", import.meta.url);
const workflowPath = new URL(
  "../../.github/workflows/desktop-release.yml",
  import.meta.url
);
const promoteWorkflowPath = new URL(
  "../../.github/workflows/desktop-release-promote.yml",
  import.meta.url
);
const buildScriptPath = new URL(
  "../../tools/scripts/build-desktop-package.sh",
  import.meta.url
);
const windowsAlphaWorkflowPath = new URL(
  "../../.github/workflows/windows-desktop-alpha.yml",
  import.meta.url
);
const storeWorkflowPath = new URL(
  "../../.github/workflows/desktop-store-submit.yml",
  import.meta.url
);
const managedPosixShellVendorScriptPath = new URL(
  "../../apps/desktop/scripts/vendor-managed-posix-shell.mjs",
  import.meta.url
);
const managedPosixShellLockPath = new URL(
  "../../config/tutti.managed-posix-shell.lock.json",
  import.meta.url
);
const mutagenVendorScriptPath = new URL(
  "../../apps/desktop/scripts/vendor-mutagen.mjs",
  import.meta.url
);
const mutagenLockPath = new URL(
  "../../config/tutti.mutagen.lock.json",
  import.meta.url
);
const managedUVVendorScriptPath = new URL(
  "../../apps/desktop/scripts/vendor-managed-uv.mjs",
  import.meta.url
);
const tuttidManagerPath = new URL(
  "../../apps/desktop/src/main/daemon/tuttidManager.ts",
  import.meta.url
);
const claudeSidecarVendorScriptPath = new URL(
  "../../apps/desktop/scripts/vendor-claude-sdk-sidecar.mjs",
  import.meta.url
);
const electronViteConfigPath = new URL(
  "../../apps/desktop/electron.vite.config.ts",
  import.meta.url
);
const browserNodeGuestPreloadPath = new URL(
  "../../apps/desktop/src/preload/entries/browserNodeGuest.ts",
  import.meta.url
);
const loopbackPreviewProxyPath = new URL(
  "../../packages/browser/workbench-node/src/electron-main/loopbackPreviewProxy.ts",
  import.meta.url
);
const desktopBuildIconPath = new URL(
  "../../apps/desktop/build/icon.png",
  import.meta.url
);
const desktopStoreManifestPath = new URL(
  "../../apps/desktop/build/appxmanifest.xml",
  import.meta.url
);
const desktopStoreAssetDimensions = new Map([
  ["StoreLogo.png", [50, 50]],
  ["Square44x44Logo.png", [44, 44]],
  ["Square150x150Logo.png", [150, 150]],
  ["Wide310x150Logo.png", [310, 150]]
]);

function readPngDimensions(buffer) {
  assert.equal(buffer.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(buffer.subarray(12, 16).toString("ascii"), "IHDR");
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

function readPngAlphaRange(buffer) {
  assert.equal(buffer.readUInt8(24), 8, "Store assets must use 8-bit PNG data");
  assert.equal(buffer.readUInt8(25), 6, "Store assets must use RGBA PNG data");
  assert.equal(
    buffer.readUInt8(28),
    0,
    "Interlaced Store assets are unsupported"
  );

  const [width, height] = readPngDimensions(buffer);
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    if (chunkType === "IDAT") {
      chunks.push(buffer.subarray(offset + 8, offset + 8 + chunkLength));
    }
    offset += chunkLength + 12;
    if (chunkType === "IEND") break;
  }

  const decoded = inflateSync(Buffer.concat(chunks));
  const bytesPerPixel = 4;
  const rowLength = width * bytesPerPixel;
  let decodedOffset = 0;
  let previous = Buffer.alloc(rowLength);
  let minAlpha = 255;
  let maxAlpha = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = decoded[decodedOffset];
    decodedOffset += 1;
    const current = Buffer.alloc(rowLength);
    for (let x = 0; x < rowLength; x += 1) {
      const encoded = decoded[decodedOffset];
      decodedOffset += 1;
      const left = x >= bytesPerPixel ? current[x - bytesPerPixel] : 0;
      const above = previous[x];
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) {
        const estimate = left + above - upperLeft;
        const leftDistance = Math.abs(estimate - left);
        const aboveDistance = Math.abs(estimate - above);
        const upperLeftDistance = Math.abs(estimate - upperLeft);
        predictor =
          leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
            ? left
            : aboveDistance <= upperLeftDistance
              ? above
              : upperLeft;
      } else {
        assert.equal(filter, 0, `Unsupported PNG row filter ${filter}`);
      }
      current[x] = (encoded + predictor) & 0xff;
    }
    for (let x = 3; x < rowLength; x += bytesPerPixel) {
      minAlpha = Math.min(minAlpha, current[x]);
      maxAlpha = Math.max(maxAlpha, current[x]);
    }
    previous = current;
  }

  return [minAlpha, maxAlpha];
}

test("desktop package includes runtime outputs without repository source", async () => {
  const packageJson = JSON.parse(await readFile(desktopPackagePath, "utf8"));

  assert.deepEqual(packageJson.build.files, ["out/**", "package.json"]);
});

test("desktop release workflow uses the published desktop package name", async () => {
  const packageJson = JSON.parse(await readFile(desktopPackagePath, "utf8"));
  const workflow = await readFile(workflowPath, "utf8");
  const packageName = packageJson.name;

  assert.equal(typeof packageName, "string");
  assert.match(packageName, /^@tutti-os\/desktop$/);

  const filterMatches = [
    ...workflow.matchAll(
      /pnpm --filter (\S+) build:(?:mac:unsigned|mac:signed|win|linux)/g
    )
  ];

  assert.ok(
    filterMatches.length > 0,
    "desktop release workflow should invoke package-scoped build commands"
  );

  for (const [, filterName] of filterMatches) {
    assert.equal(
      filterName,
      packageName,
      `desktop release workflow filter should stay aligned with ${packageName}`
    );
  }
});

test("desktop release submits only stable builds to an isolated Store workflow", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const storeWorkflow = await readFile(storeWorkflowPath, "utf8");

  assert.match(workflow, /submit-store:/);
  assert.match(
    workflow,
    /needs\.resolve\.outputs\.release_channel == 'stable'/
  );
  assert.match(
    workflow,
    /vars\.TUTTI_WINDOWS_STORE_SUBMISSION_ENABLED == 'true'/
  );
  assert.doesNotMatch(workflow, /publication_mode|draft_only/);
  assert.match(workflow, /needs:\s*\[resolve, promote\]/);
  assert.match(
    workflow,
    /uses:\s+\.\/\.github\/workflows\/desktop-store-submit\.yml/
  );
  assert.match(workflow, /store_environment:\s+microsoft-store-production/);
  assert.doesNotMatch(
    workflow,
    /needs:\s*\[resolve, build-macos, build-windows, submit-store\]/
  );

  assert.match(storeWorkflow, /workflow_call:/);
  assert.match(storeWorkflow, /workflow_dispatch:/);
  const stableTagPattern = storeWorkflow.match(/-notmatch '([^']+)'/)?.[1];
  assert.ok(stableTagPattern, "Store workflow should validate its stable tag");
  const stableTagRegex = new RegExp(stableTagPattern);
  assert.equal(stableTagRegex.exec("v1.2.3")?.groups?.version, "1.2.3");
  assert.equal(stableTagRegex.exec("v0.0.0")?.groups?.version, "0.0.0");
  assert.equal(stableTagRegex.test("v1.2.3-rc.1"), false);
  assert.match(
    storeWorkflow,
    /uses:\s+microsoft\/microsoft-store-apppublisher@v1\.1/
  );
  assert.match(storeWorkflow, /msstore reconfigure/);
  assert.match(storeWorkflow, /msstore publish/);
  assert.match(storeWorkflow, /ChangeExtension\(\$appxPath, '\.msix'\)/);
  assert.doesNotMatch(storeWorkflow, /msstore submission poll/);
  assert.match(storeWorkflow, /TUTTI_STORE_IDENTITY_NAME/);
  assert.match(storeWorkflow, /TUTTI_STORE_PUBLISHER/);
  assert.match(
    storeWorkflow,
    /'TUTTI_STORE_APPLICATION_ID',[\s\S]*?'TUTTI_STORE_DISPLAY_NAME'/
  );
  assert.match(storeWorkflow, /Store package display name mismatch/);
  assert.match(storeWorkflow, /Store application id mismatch/);
  assert.match(storeWorkflow, /Store executable mismatch/);
  assert.match(storeWorkflow, /Store entry point mismatch/);
  assert.match(storeWorkflow, /Installed application display name mismatch/);
  assert.match(
    storeWorkflow,
    /application tile background must be transparent/
  );
  assert.match(storeWorkflow, /application must appear in the Start menu/);
  assert.match(storeWorkflow, /does not declare the Tutti desktop shortcut/);
  assert.match(storeWorkflow, /Store desktop shortcut path mismatch/);
  assert.match(storeWorkflow, /Store desktop shortcut icon mismatch/);
  assert.match(storeWorkflow, /Store package did not use branded asset/);
  for (const assetName of desktopStoreAssetDimensions.keys()) {
    assert.match(storeWorkflow, new RegExp(assetName.replaceAll(".", "\\.")));
  }
  assert.match(storeWorkflow, /@Name='tutti'/);
  assert.match(storeWorkflow, /@Name='runFullTrust'/);
  assert.match(storeWorkflow, /Get-FileHash .* -Algorithm SHA256/);
});

test("desktop Store packaging reuses the Windows payload and emits AppX only", async () => {
  const packageJson = JSON.parse(await readFile(desktopPackagePath, "utf8"));
  const buildScript = await readFile(buildScriptPath, "utf8");
  const storeManifest = await readFile(desktopStoreManifestPath, "utf8");

  assert.equal(
    packageJson.description,
    "Where people and agents build in tune."
  );
  assert.equal(
    packageJson.scripts["build:win:store"],
    "bash ../../tools/scripts/build-desktop-package.sh win-store"
  );
  assert.equal(packageJson.build.appx.electronUpdaterAware, false);
  assert.equal(packageJson.build.appx.minVersion, "10.0.17763.0");
  assert.equal(packageJson.build.appx.maxVersionTested, "10.0.26100.0");
  assert.equal(
    packageJson.build.appx.customManifestPath,
    "build/appxmanifest.xml"
  );
  assert.deepEqual(packageJson.build.appx.capabilities, ["runFullTrust"]);
  assert.match(
    storeManifest,
    /<Properties>[\s\S]*?<DisplayName>\$\{displayName\}<\/DisplayName>/
  );
  assert.match(storeManifest, /<uap:VisualElements[\s\S]*?DisplayName="Tutti"/);
  assert.match(storeManifest, /BackgroundColor="transparent"/);
  assert.match(storeManifest, /AppListEntry="default"/);
  assert.match(
    storeManifest,
    /xmlns:desktop7="http:\/\/schemas\.microsoft\.com\/appx\/manifest\/desktop\/windows10\/7"/
  );
  assert.match(storeManifest, /IgnorableNamespaces="desktop7"/);
  assert.match(
    storeManifest,
    /<desktop7:Extension Category="windows\.shortcut">[\s\S]*?File="\$\(Desktop\)\\Tutti\.lnk"[\s\S]*?Icon="app\\Tutti\.exe"/
  );
  assert.doesNotMatch(storeManifest, /\$\{extensions\}/);
  assert.deepEqual(packageJson.build.win.protocols, [
    {
      name: "Tutti login callback",
      schemes: ["tutti"]
    }
  ]);
  assert.match(buildScript, /win\|win-store/);
  assert.match(buildScript, /electron-builder --win appx --x64/);
  assert.match(buildScript, /TUTTI_STORE_IDENTITY_NAME/);
  assert.match(buildScript, /TUTTI_STORE_PUBLISHER/);
  assert.match(
    buildScript,
    /win-store\)\s*\n\s*run_timed_phase "electron_builder_win_store" run_electron_builder_win_store/
  );
});

test("desktop Store packaging provides branded assets for every manifest tile", async () => {
  for (const [fileName, expectedDimensions] of desktopStoreAssetDimensions) {
    const assetPath = new URL(
      `../../apps/desktop/build/appx/${fileName}`,
      import.meta.url
    );
    const asset = await readFile(assetPath);

    assert.deepEqual(
      readPngDimensions(asset),
      expectedDimensions,
      `${fileName} should use the dimensions expected by electron-builder`
    );
    assert.deepEqual(
      readPngAlphaRange(asset),
      [0, 255],
      `${fileName} should preserve fully transparent and fully opaque pixels`
    );
  }
});

test("desktop release workflow publishes rc tags as prereleases and keeps stable tags as latest", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /push:\s*\n\s*tags:\s*\n\s*-\s*"v\*"/);
  assert.doesNotMatch(workflow, /-\s*"tutti-desktop-v\*"/);
  assert.match(workflow, /default:\s*patch_rc_release/);
  assert.match(
    workflow,
    /release_mode:[\s\S]*?options:\s*\r?\n\s*-\s*unsigned_dry_run\r?\n\s*-\s*patch_beta_release\r?\n\s*-\s*patch_rc_release\r?\n\s*-\s*patch_release\r?\n\s*-\s*minor_release\r?\n\s*-\s*major_release\r?\n\s*-\s*explicit_version_release/
  );
  assert.match(
    workflow,
    /prerelease:\s+\${{\s*needs\.resolve\.outputs\.release_prerelease\s*==\s*'true'\s*}}/
  );
  assert.match(
    workflow,
    /make_latest:\s+\${{\s*needs\.resolve\.outputs\.release_make_latest\s*==\s*'true'\s*}}/
  );
  assert.match(
    workflow,
    /release_channel:\s+\${{\s*steps\.release\.outputs\.release_channel\s*}}/
  );
  assert.match(workflow, /patch_beta_release\)\s*\n\s*strategy=patch_beta/);
});

test("desktop release workflow gates manual rc and stable modes by release branch", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /name:\s+Validate release dispatch branch/);
  assert.match(
    workflow,
    /RELEASE_EVENT_NAME:\s+\${{\s*github\.event_name\s*}}/
  );
  assert.match(workflow, /RELEASE_REF_NAME:\s+\${{\s*github\.ref_name\s*}}/);
  assert.match(workflow, /RELEASE_REF_TYPE:\s+\${{\s*github\.ref_type\s*}}/);
  assert.match(
    workflow,
    /if \[\[ "\$\{RELEASE_EVENT_NAME\}" != "workflow_dispatch" \]\]; then/
  );
  assert.match(
    workflow,
    /patch_rc_release\|patch_release\|minor_release\|major_release\)/
  );
  assert.match(workflow, /patch_release\|minor_release\|major_release\)/);
  assert.match(workflow, /main\|release\/\*/);
  assert.match(
    workflow,
    /git ls-remote --heads origin "refs\/heads\/release\/\*"/
  );
  assert.match(
    workflow,
    /Stable desktop release modes must run from a release\/\* branch while release branches exist\./
  );
});

test("desktop promotion requires the managed app runtime release first", async () => {
  const promoteWorkflow = await readFile(promoteWorkflowPath, "utf8");
  const checkoutIndex = promoteWorkflow.indexOf(
    "name: Checkout release target"
  );
  const runtimeGateIndex = promoteWorkflow.indexOf(
    "name: Verify managed app runtime is published"
  );
  const downloadIndex = promoteWorkflow.indexOf(
    "name: Download staged GitHub release assets"
  );

  assert.ok(checkoutIndex >= 0, "promotion should checkout the release target");
  assert.ok(
    runtimeGateIndex > checkoutIndex,
    "runtime gate should read the lock from the release target"
  );
  assert.ok(
    downloadIndex > runtimeGateIndex,
    "runtime gate should pass before promotion begins"
  );
  assert.match(
    promoteWorkflow,
    /node tools\/scripts\/verify-tutti-app-runtime-release\.mjs/
  );
});

test("desktop release workflow schedules a daily Beijing 4:16am rc release", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /schedule:\s*\n\s*-\s*cron:\s*"16 20 \* \* \*"/);
  assert.doesNotMatch(workflow, /timezone:\s*"Asia\/Shanghai"/);
  assert.match(
    workflow,
    /RELEASE_EVENT_NAME:\s+\${{\s*github\.event_name\s*}}/
  );
  assert.match(
    workflow,
    /if \[\[ "\$\{RELEASE_EVENT_NAME\}" == "schedule" \]\]; then\s*\n\s*strategy=patch_rc/
  );
});

test("desktop release workflow keeps less common rc bumps behind explicit version input", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /minor_rc_release\)/);
  assert.match(workflow, /major_rc_release\)/);
  assert.doesNotMatch(workflow, /tag_name:\s*\n/);
});

test("desktop release workflow defers stable tags but still reserves prerelease tags", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /^concurrency:\s*$/m);
  assert.match(workflow, /cancel-in-progress:\s+false/);
  assert.match(workflow, /apps\/desktop\/scripts\/reserve-release-tag\.mjs/);
  assert.match(workflow, /release_candidate=true/);
  assert.match(workflow, /release_channel.*stable/);
  assert.match(workflow, /reserve_args=.*--strategy explicit_tag/);
  assert.match(workflow, /release_candidate != 'true'/);
});

test("desktop release workflow passes tsh-aligned Feishu card context", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /FEISHU_WEBHOOK_URL:\s+\${{\s*secrets\.FEISHU_RELEASE_WEBHOOK_URL\s*}}/
  );
  assert.match(workflow, /RELEASE_ACTOR:\s+\${{\s*github\.actor\s*}}/);
  assert.match(
    workflow,
    /RELEASE_BRANCH:\s+\${{\s*github\.ref_type == 'branch' && github\.ref_name \|\| ''\s*}}/
  );
  assert.match(
    workflow,
    /TUTTI_DESKTOP_RELEASE_ASSETS_BASE_URL:\s+\${{\s*vars\.TUTTI_DESKTOP_RELEASE_ASSETS_BASE_URL\s*}}/
  );
  assert.match(
    workflow,
    /release_url:\s*\${{\s*needs\.resolve\.outputs\.release_candidate\s*==\s*'true'[\s\S]*steps\.stage-candidate-release\.outputs\.release_url/
  );
  assert.match(
    workflow,
    /id:\s+stage-release\s*\n\s*name:\s+Stage GitHub release assets/
  );
  assert.match(
    workflow,
    /RELEASE_URL:\s+\${{\s*needs\.stage\.outputs\.release_url\s*}}/
  );
  assert.doesNotMatch(workflow, /RELEASE_ASSET_DIRECTORY:\s+release-assets/);
});

test("desktop release workflow scopes generated notes to the previous release tag", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const previousTagIndex = workflow.indexOf(
    "name: Resolve previous GitHub release tag"
  );
  const stageIndex = workflow.indexOf("name: Stage GitHub release assets");

  assert.notEqual(
    previousTagIndex,
    -1,
    "the previous release tag should be resolved"
  );
  assert.ok(
    previousTagIndex < stageIndex,
    "the previous release tag should be resolved first"
  );
  assert.match(
    workflow,
    /node apps\/desktop\/scripts\/resolve-previous-release-tag\.mjs/
  );
  assert.match(workflow, /generate_release_notes:\s+true/);
  assert.match(
    workflow,
    /previous_tag:\s+\${{\s*steps\.previous-release-tag\.outputs\.tag\s*}}/
  );
});

test("desktop release workflow defaults Feishu notifications on outside manual dispatch", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.doesNotMatch(
    workflow,
    /notify_feishu=\${{\s*inputs\.notify_feishu\s*!=\s*false\s*}}/
  );
  assert.match(
    workflow,
    /notify_feishu=\${{\s*github\.event_name\s*!=\s*'workflow_dispatch'\s*\|\|\s*inputs\.notify_feishu\s*!=\s*false\s*}}/
  );
});

test("desktop release post-stage jobs tolerate skipped optional dependencies", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const promoteJob = workflow.match(
    /promote:[\s\S]*?(?=\n\s{2}[a-z][a-z0-9_-]+:\n|$)/
  )?.[0];
  const notifyJob = workflow.match(
    /notify-candidate-feishu:[\s\S]*?(?=\n\s{2}[a-z][a-z0-9_-]+:\n|$)/
  )?.[0];

  assert.ok(promoteJob, "promote job should exist");
  assert.ok(notifyJob, "candidate notify job should exist");
  assert.match(promoteJob, /if:\s+\${{\s*always\(\)\s*&&/);
  assert.match(promoteJob, /needs\.stage\.result\s*==\s*'success'/);
  assert.match(notifyJob, /if:\s+\${{\s*always\(\)\s*&&/);
  assert.match(notifyJob, /needs\.stage\.result\s*==\s*'success'/);
});

test("desktop release workflow does not redownload release assets for Feishu", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const notifyJobMatch = workflow.match(
    /notify-candidate-feishu:[\s\S]*?(?=\n\s{2}[a-z][a-z0-9_-]+:\n|$)/
  );

  assert.ok(notifyJobMatch, "candidate notify job should exist");

  const notifyJob = notifyJobMatch[0];
  const checkoutIndex = notifyJob.indexOf("name: Checkout notification script");
  const setupNodeIndex = notifyJob.indexOf("name: Setup Node.js");
  const summaryIndex = notifyJob.indexOf("name: Download release summary");
  const sendIndex = notifyJob.indexOf("name: Send candidate release card");

  assert.notEqual(checkoutIndex, -1, "notify job should checkout the script");
  assert.notEqual(setupNodeIndex, -1, "notify job should setup Node.js");
  assert.notEqual(summaryIndex, -1, "notify job should download the summary");
  assert.notEqual(sendIndex, -1, "notify job should send the release card");
  assert.equal(notifyJob.indexOf("name: Download built artifacts"), -1);
  assert.equal(notifyJob.indexOf("RELEASE_ASSET_DIRECTORY"), -1);
  assert.ok(checkoutIndex < summaryIndex);
  assert.ok(setupNodeIndex < summaryIndex);
  assert.ok(summaryIndex < sendIndex);
});

test("desktop promotion workflow does not redownload release assets for Feishu", async () => {
  const promoteWorkflow = await readFile(promoteWorkflowPath, "utf8");
  const notifyJobMatch = promoteWorkflow.match(
    /notify-feishu:[\s\S]*?(?=\n\s{2}[a-z][a-z0-9_-]+:\n|$)/
  );

  assert.ok(notifyJobMatch, "promotion notify job should exist");
  assert.doesNotMatch(
    notifyJobMatch[0],
    /Download promoted release assets|RELEASE_ASSET_DIRECTORY/
  );
  assert.match(notifyJobMatch[0], /name:\s+Download release summary/);
  assert.match(notifyJobMatch[0], /name:\s+Send release card/);
});

test("desktop release workflow can mirror release assets to S3 and upsert direct download links", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const promoteWorkflow = await readFile(promoteWorkflowPath, "utf8");

  assert.match(
    workflow,
    /permissions:\s*\n\s*contents:\s*write\s*\n\s*id-token:\s*write/
  );
  assert.match(workflow, /Upload immutable draft assets to AWS S3/);
  assert.match(workflow, /aws-actions\/configure-aws-credentials@v4/);
  assert.match(
    workflow,
    /TUTTI_DESKTOP_RELEASE_ASSETS_BASE_URL=https:\/\/\${TUTTI_DESKTOP_RELEASE_ASSETS_S3_BUCKET}\.s3-accelerate\.amazonaws\.com\/\${TUTTI_DESKTOP_RELEASE_ASSETS_S3_PREFIX%\/}/
  );
  assert.match(
    `${workflow}\n${promoteWorkflow}`,
    /apps\/desktop\/scripts\/upsert-release-download-links\.mjs/
  );
  assert.match(promoteWorkflow, /Build public release pointer/);
  assert.match(
    promoteWorkflow,
    /apps\/desktop\/scripts\/build-release-latest\.mjs/
  );
  assert.match(
    promoteWorkflow,
    /aws s3 cp release-latest\.json "\$\{s3_root\}\/latest\.json"/
  );
});

test("desktop release workflow only publishes root latest metadata for stable releases", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const promoteWorkflow = await readFile(promoteWorkflowPath, "utf8");

  assert.doesNotMatch(workflow, /publication_mode|draft_only/);
  assert.match(
    workflow,
    /needs\.stage\.result == 'success' && needs\.resolve\.outputs\.release_candidate != 'true'/
  );
  assert.doesNotMatch(workflow, /channels\/rc\/latest\.json/);
  assert.doesNotMatch(workflow, /aws s3 cp release-latest\.json/);
  assert.match(
    promoteWorkflow,
    /if \[\[ "\$\{TUTTI_DESKTOP_RELEASE_CHANNEL\}" == "stable" \]\]; then[\s\S]*"\$\{s3_root\}\/latest\.json"/
  );
  assert.match(
    promoteWorkflow,
    /channels\/preview\/latest\.json[\s\S]*channels\/rc\/latest\.json/
  );
  assert.match(promoteWorkflow, /channels\/beta\/latest\.json/);
});

test("desktop release workflow publishes immutable updater files before channel pointers", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const promoteWorkflow = await readFile(promoteWorkflowPath, "utf8");
  const draftAssetsIndex = workflow.indexOf(
    "name: Upload immutable draft assets to AWS S3"
  );
  const promoteAssetsIndex = promoteWorkflow.indexOf(
    "name: Upload immutable release assets to AWS S3"
  );
  const pointerBuildIndex = promoteWorkflow.indexOf(
    "name: Build public release pointer"
  );
  const pointerUploadIndex = promoteWorkflow.indexOf(
    "name: Publish release pointer to AWS S3"
  );

  assert.ok(draftAssetsIndex >= 0, "draft assets should upload immutably");
  assert.ok(promoteAssetsIndex >= 0, "promotion should repair missing assets");
  assert.ok(pointerBuildIndex > promoteAssetsIndex);
  assert.ok(pointerUploadIndex > pointerBuildIndex);
  assert.match(promoteWorkflow, /channels\/rc\/latest\.json/);
  assert.match(promoteWorkflow, /--cache-control "public, max-age=60"/);
});

test("desktop package uses the CloudFront generic updater provider", async () => {
  const packageJson = JSON.parse(await readFile(desktopPackagePath, "utf8"));

  assert.deepEqual(packageJson.build.publish, [
    {
      provider: "generic",
      url: "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-desktop-release-assets"
    }
  ]);
});

test("desktop release workflow generates summaries and stable changelog metadata", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const promoteWorkflow = await readFile(promoteWorkflowPath, "utf8");
  const releaseWorkflows = `${workflow}\n${promoteWorkflow}`;

  assert.match(releaseWorkflows, /Generate desktop release summary/);
  assert.match(
    releaseWorkflows,
    /apps\/desktop\/scripts\/generate-release-summary\.mjs/
  );
  assert.match(releaseWorkflows, /secrets\.AGNES_API_KEY/);
  assert.match(releaseWorkflows, /Upload desktop release summary artifact/);
  assert.match(releaseWorkflows, /Update release notes with summary/);
  assert.match(
    releaseWorkflows,
    /apps\/desktop\/scripts\/upsert-release-summary\.mjs/
  );
  assert.match(promoteWorkflow, /Update stable changelog metadata/);
  assert.match(
    promoteWorkflow,
    /apps\/desktop\/scripts\/upsert-release-changelog\.mjs/
  );
  assert.match(
    promoteWorkflow,
    /grep -Eq "\(404\|NoSuchKey\|Not Found\)" changelog-download\.err/
  );
  assert.match(
    promoteWorkflow,
    /"schemaVersion":"tutti\.desktop\.changelog\.v1"/
  );
  assert.match(promoteWorkflow, /"\$\{s3_root\}\/changelog\.json"/);
  assert.match(releaseWorkflows, /Download release summary/);
  assert.match(
    releaseWorkflows,
    /RELEASE_SUMMARY_PATH:\s+release-summary\/release-summary\.json/
  );
});

test("desktop promotion consumes the checksummed summary staged with the draft", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const promoteWorkflow = await readFile(promoteWorkflowPath, "utf8");

  const summaryIndex = workflow.indexOf(
    "name: Generate desktop release summary"
  );
  const validationIndex = workflow.indexOf(
    "name: Validate desktop release summary"
  );
  const checksumIndex = workflow.indexOf("name: Generate checksums");
  const draftIndex = workflow.indexOf("name: Stage GitHub release assets");
  assert.notEqual(summaryIndex, -1);
  assert.notEqual(validationIndex, -1);
  assert.notEqual(checksumIndex, -1);
  assert.notEqual(draftIndex, -1);
  assert.ok(summaryIndex < validationIndex);
  assert.ok(validationIndex < checksumIndex);
  assert.ok(checksumIndex < draftIndex);
  assert.match(workflow, /--output release-assets\/release-summary\.json/);
  assert.match(
    workflow,
    /validate-release-summary\.mjs release-assets\/release-summary\.json/
  );
  assert.match(promoteWorkflow, /release-assets\/release-summary\.json/);
  assert.doesNotMatch(
    promoteWorkflow,
    /Generate desktop release summary|secrets\.AGNES_API_KEY/
  );
});

test("desktop release workflow keeps prereleases as drafts and reserves the public list for stable", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const promoteWorkflow = await readFile(promoteWorkflowPath, "utf8");
  const stageJobMatch = workflow.match(
    /stage:[\s\S]*?(?=\n\s{2}[a-z][a-z0-9_-]+:\n|$)/
  );

  assert.ok(stageJobMatch, "stage job should exist");
  const stageJob = stageJobMatch[0];
  const stageIndex = stageJob.indexOf("name: Stage GitHub release assets");
  const s3Index = stageJob.indexOf(
    "name: Upload immutable draft assets to AWS S3"
  );
  const publishIndex = promoteWorkflow.indexOf(
    "name: Publish stable GitHub release"
  );
  const archiveIndex = promoteWorkflow.indexOf(
    "name: Archive public GitHub prereleases"
  );
  const stableAliasIndex = promoteWorkflow.indexOf(
    "name: Refresh stable release alias"
  );

  assert.notEqual(stageIndex, -1, "release assets should be staged");
  assert.notEqual(s3Index, -1, "draft assets should be uploaded to AWS");
  assert.notEqual(
    publishIndex,
    -1,
    "stable release should be published explicitly"
  );
  assert.notEqual(
    archiveIndex,
    -1,
    "legacy public prereleases should be archived"
  );
  assert.notEqual(stableAliasIndex, -1, "stable release alias should refresh");
  assert.match(stageJob, /draft:\s*true/);
  assert.doesNotMatch(stageJob, /latest\.json/);
  assert.doesNotMatch(stageJob, /--draft=false/);
  assert.match(
    workflow,
    /uses:\s+\.\/\.github\/workflows\/desktop-release-promote\.yml/
  );
  assert.doesNotMatch(workflow, /publication_mode|draft_only/);
  assert.match(
    promoteWorkflow,
    /if:\s*\$\{\{\s*needs\.resolve\.outputs\.release_channel\s*==\s*'stable'\s*\}\}/
  );
  assert.match(
    promoteWorkflow,
    /gh release edit "\$\{TUTTI_DESKTOP_RELEASE_TAG\}" --draft=false --latest/
  );
  assert.match(
    promoteWorkflow,
    /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/releases\?per_page=100" --paginate/
  );
  assert.match(
    promoteWorkflow,
    /select\(\.prerelease and \(\.draft \| not\)\) \| \.id/
  );
  assert.match(
    promoteWorkflow,
    /gh api --method PATCH "repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$\{release_id\}"[\s\\]*-F draft=true/
  );
  assert.ok(stageIndex < s3Index);
  assert.ok(publishIndex < archiveIndex);
  assert.ok(archiveIndex < stableAliasIndex);
});

test("desktop promotion validates draft identity, checksums, and channel ordering", async () => {
  const promoteWorkflow = await readFile(promoteWorkflowPath, "utf8");

  assert.match(promoteWorkflow, /workflow_call:/);
  assert.match(promoteWorkflow, /workflow_dispatch:/);
  assert.match(promoteWorkflow, /group:\s+desktop-release-promotion/);
  assert.match(
    promoteWorkflow,
    /\.tag_name == \\"\$\{release_tag\}\\" or \.tag_name == \\"\$\{release_candidate_tag\}\\"/
  );
  assert.match(
    promoteWorkflow,
    /git fetch --force origin "refs\/tags\/\$\{release_tag\}:refs\/tags\/\$\{release_tag\}"/
  );
  assert.match(promoteWorkflow, /sha256sum --check SHA256SUMS\.txt/);
  assert.match(promoteWorkflow, /name:\s+Prevent release channel rollback/);
  assert.match(promoteWorkflow, /Refusing to move/);
  assert.match(promoteWorkflow, /name:\s+Verify public release pointer/);
});

test("stable candidates require environment approval and bind the reviewed notes", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const promoteWorkflow = await readFile(promoteWorkflowPath, "utf8");

  assert.match(workflow, /build-release-candidate-manifest\.mjs/);
  assert.match(workflow, /release_candidate_tag="candidate-\$\{release_tag\}"/);
  assert.match(workflow, /releases\/assets\/\$\{asset_id\}/);
  assert.match(
    workflow,
    /candidates\/\$\{TUTTI_DESKTOP_RELEASE_CANDIDATE_ID\}/
  );
  assert.match(workflow, /PROMOTION_URL:/);
  assert.match(promoteWorkflow, /environment:\s+desktop-stable-release/);
  assert.match(promoteWorkflow, /extract-approved-release-summary\.mjs/);
  assert.match(promoteWorkflow, /verify-release-candidate\.mjs/);
  assert.match(
    promoteWorkflow,
    /RELEASE_TAG="\$\{release_tag\}" RELEASE_TARGET="\$\{draft_target_sha\}"/
  );
  assert.match(
    promoteWorkflow,
    /Release notes or candidate assets changed after approval/
  );
  assert.match(promoteWorkflow, /Create stable release tag after approval/);
  assert.match(promoteWorkflow, /Protect immutable stable asset path/);
  assert.match(promoteWorkflow, /\.promotion-candidate\.json/);
});

test("stable promotion can resume after the GitHub release becomes public", async () => {
  const promoteWorkflow = await readFile(promoteWorkflowPath, "utf8");
  const publishIndex = promoteWorkflow.indexOf(
    "name: Publish stable GitHub release"
  );
  const verifyPointerIndex = promoteWorkflow.indexOf(
    "name: Verify public release pointer"
  );
  const cleanupIndex = promoteWorkflow.indexOf(
    "name: Remove internal candidate manifest from published release"
  );

  assert.match(
    promoteWorkflow,
    /\(\.draft \| not\) and \.tag_name == \\"\$\{release_tag\}\\" and \(\.prerelease \| not\)/
  );
  assert.match(
    promoteWorkflow,
    /release_already_published=true[\s\S]*release_already_published=\$\{release_already_published\}/
  );
  assert.match(
    promoteWorkflow,
    /Attach approved draft to the stable tag[\s\S]*release_already_published != 'true'/
  );
  assert.ok(publishIndex >= 0, "stable publish step should exist");
  assert.ok(
    verifyPointerIndex > publishIndex,
    "public pointer verification should remain retryable after publication"
  );
  assert.ok(
    cleanupIndex > verifyPointerIndex,
    "candidate recovery metadata should be removed only after all fallible promotion checks"
  );
});

test("desktop release workflow refreshes the stable alias without taking Latest", async () => {
  const promoteWorkflow = await readFile(promoteWorkflowPath, "utf8");
  const stableAliasStep = promoteWorkflow.match(
    /- name: Refresh stable release alias[\s\S]*?(?=\n\s{6}- name:|\n\s{2}[a-z][a-z0-9_-]+:\n|$)/
  )?.[0];

  assert.ok(stableAliasStep, "stable alias step should exist");
  assert.match(stableAliasStep, /TUTTI_DESKTOP_RELEASE_CHANNEL/);
  assert.match(stableAliasStep, /gh release list/);
  assert.match(stableAliasStep, /--exclude-drafts/);
  assert.match(stableAliasStep, /--exclude-pre-releases/);
  assert.match(stableAliasStep, /\.tagName != "stable"/);
  assert.match(
    stableAliasStep,
    /select\(\.tagName != "stable" and \(\.tagName \| test\("\^v\[0-9\]\+\\\\\.\[0-9\]\+\\\\\.\[0-9\]\+\$"\)\)\)\]/
  );
  assert.match(
    stableAliasStep,
    /apps\/desktop\/scripts\/build-stable-release-alias-body\.mjs/
  );
  assert.match(
    stableAliasStep,
    /stable_tree="\$\(git rev-parse "\$\{stable_sha\}\^\{tree\}"\)"/
  );
  assert.match(stableAliasStep, /GIT_AUTHOR_NAME="github-actions\[bot\]"/);
  assert.match(
    stableAliasStep,
    /GIT_AUTHOR_EMAIL="41898282\+github-actions\[bot\]@users\.noreply\.github\.com"/
  );
  assert.match(stableAliasStep, /GIT_AUTHOR_DATE="\$\{stable_alias_time\}"/);
  assert.match(stableAliasStep, /GIT_COMMITTER_NAME="github-actions\[bot\]"/);
  assert.match(
    stableAliasStep,
    /GIT_COMMITTER_EMAIL="41898282\+github-actions\[bot\]@users\.noreply\.github\.com"/
  );
  assert.match(
    stableAliasStep,
    /Signed-off-by: github-actions\[bot\] <41898282\+github-actions\[bot\]@users\.noreply\.github\.com>/
  );
  assert.match(
    stableAliasStep,
    /git commit-tree "\$\{stable_tree\}" -p "\$\{stable_sha\}"/
  );
  assert.match(
    stableAliasStep,
    /stable_alias_tree="\$\(git rev-parse "\$\{stable_alias_sha\}\^\{tree\}"\)"/
  );
  assert.match(
    stableAliasStep,
    /stable_alias_parent="\$\(git rev-parse "\$\{stable_alias_sha\}\^"\)"/
  );
  assert.match(stableAliasStep, /Stable alias tree mismatch:/);
  assert.match(stableAliasStep, /Stable alias parent mismatch:/);
  assert.match(stableAliasStep, /git tag -f stable "\$\{stable_alias_sha\}"/);
  assert.doesNotMatch(stableAliasStep, /git tag -f stable "\$\{stable_sha\}"/);
  assert.match(stableAliasStep, /git push origin refs\/tags\/stable --force/);
  assert.match(stableAliasStep, /gh release delete stable --yes/);
  assert.doesNotMatch(stableAliasStep, /--cleanup-tag/);
  assert.doesNotMatch(stableAliasStep, /git push origin :refs\/tags\/stable/);
  assert.doesNotMatch(stableAliasStep, /git tag -a/);
  assert.match(stableAliasStep, /gh release create stable/);
  assert.match(stableAliasStep, /--verify-tag/);
  assert.match(stableAliasStep, /--title "Stable \(Recommended\)"/);
  assert.doesNotMatch(stableAliasStep, /--target "\$\{stable_sha\}"/);
  assert.match(stableAliasStep, /--latest=false/);
  assert.match(stableAliasStep, /gh release edit "\$\{stable_tag\}" --latest/);

  const aliasCommitIndex = stableAliasStep.indexOf("git commit-tree");
  const tagPushIndex = stableAliasStep.indexOf(
    "git push origin refs/tags/stable --force"
  );
  const releaseDeleteIndex = stableAliasStep.indexOf(
    "gh release delete stable --yes"
  );
  const releaseCreateIndex = stableAliasStep.indexOf(
    "gh release create stable"
  );

  assert.ok(aliasCommitIndex < tagPushIndex);
  assert.ok(tagPushIndex < releaseDeleteIndex);
  assert.ok(releaseDeleteIndex < releaseCreateIndex);
});

test("desktop release workflow always builds Windows and stages unsigned assets", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const stageJobMatch = workflow.match(
    /stage:[\s\S]*?(?=\n\s{2}[a-z][a-z0-9_-]+:\n|$)/
  );
  const notifyJobMatch = workflow.match(
    /notify-candidate-feishu:[\s\S]*?(?=\n\s{2}[a-z][a-z0-9_-]+:\n|$)/
  );

  assert.ok(stageJobMatch, "stage job should exist");
  assert.ok(notifyJobMatch, "candidate notify job should exist");
  assert.doesNotMatch(workflow, /include_windows/);
  assert.match(workflow, /\r?\n\s{2}build-windows:\r?\n/);
  assert.doesNotMatch(workflow, /\r?\n\s{2}build-linux:\r?\n/);
  assert.match(
    workflow,
    /build-windows:[\s\S]*?CSC_IDENTITY_AUTO_DISCOVERY:\s+"false"[\s\S]*?build:win/
  );
  assert.match(
    stageJobMatch[0],
    /needs:\s+\[resolve, build-macos, build-windows\]/
  );
  assert.match(stageJobMatch[0], /always\(\)/);
  assert.match(
    stageJobMatch[0],
    /needs\.build-windows\.result\s*==\s*'success'/
  );
  assert.doesNotMatch(
    stageJobMatch[0],
    /needs\.build-windows\.result\s*==\s*'skipped'/
  );
  assert.match(
    stageJobMatch[0],
    /pattern:\s+tutti-desktop-release-assets-macos-\*/
  );
  assert.match(
    stageJobMatch[0],
    /name:\s+tutti-desktop-release-assets-windows/
  );
  assert.match(stageJobMatch[0], /name:\s+Add Windows release artifacts/);
  assert.match(
    stageJobMatch[0],
    /validate-windows-release-artifacts\.mjs release-assets/
  );
  assert.match(
    stageJobMatch[0],
    /upsert-release-download-links\.mjs[\s\S]*?release-assets[\s\S]*?updated-release-body\.md/
  );
  assert.match(
    stageJobMatch[0],
    /export RELEASE_TAG="\$\{TUTTI_DESKTOP_RELEASE_TAG\}"/
  );
  assert.match(stageJobMatch[0], /merge-multiple:\s+false/);
  assert.doesNotMatch(
    notifyJobMatch[0],
    /pattern:\s+tutti-desktop-release-assets-macos/
  );
});

test("desktop promotion verifies Windows artifacts in the release and S3 mirror", async () => {
  const promoteWorkflow = await readFile(promoteWorkflowPath, "utf8");

  assert.match(
    promoteWorkflow,
    /Verify staged release assets[\s\S]*?\*-win-x64\.exe[\s\S]*?\*-win-x64\.exe\.blockmap[\s\S]*?windows_metadata/
  );
  assert.match(
    promoteWorkflow,
    /name:\s+Validate Windows updater metadata[\s\S]*?validate-windows-release-artifacts\.mjs/
  );
  assert.match(
    promoteWorkflow,
    /name:\s+Verify mirrored Windows release assets/
  );
  assert.match(promoteWorkflow, /aws s3api head-object/);
  assert.match(promoteWorkflow, /--query ContentLength/);
  assert.match(promoteWorkflow, /Mirrored asset size mismatch/);
  assert.match(promoteWorkflow, /curl --fail --silent --show-error --location/);
  assert.match(promoteWorkflow, /Mirrored asset checksum mismatch/);
});

test("desktop release workflow materializes macOS signing certificate before packaging", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /name:\s+Prepare macOS signing certificate/);
  assert.match(
    workflow,
    /MACOS_CSC_LINK:\s+\${{\s*secrets\.MACOS_CSC_LINK\s*}}/
  );
  assert.match(
    workflow,
    /certificate_path="\$\{RUNNER_TEMP\}\/macos-codesign-certificate\.p12"/
  );
  assert.match(
    workflow,
    /echo "CSC_LINK=\$\{certificate_path\}" >> "\$\{GITHUB_ENV\}"/
  );
  assert.doesNotMatch(
    workflow,
    /Build release artifacts[\s\S]*?CSC_LINK:\s+\${{\s*secrets\.MACOS_CSC_LINK\s*}}[\s\S]*?pnpm --filter @tutti-os\/desktop build:mac:signed/
  );
});

test("desktop release macOS builds reserve enough Node heap for the renderer bundle", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /Build release artifacts[\s\S]*?NODE_OPTIONS:\s+--max-old-space-size=4096[\s\S]*?pnpm --filter @tutti-os\/desktop build:mac:signed/
  );
});

test("desktop macOS packaging builds architecture-specific and universal artifacts", async () => {
  const buildScript = await readFile(buildScriptPath, "utf8");
  const claudeSidecarVendorScript = await readFile(
    claudeSidecarVendorScriptPath,
    "utf8"
  );
  const packageJson = JSON.parse(await readFile(desktopPackagePath, "utf8"));

  assert.match(packageJson.build.artifactName, /\$\{arch\}/);
  assert.match(buildScript, /GOOS=darwin\s+GOARCH=arm64\s+go build/);
  assert.match(buildScript, /GOOS=darwin\s+GOARCH=amd64\s+go build/);
  assert.match(buildScript, /lipo\s+-create/);
  assert.match(
    buildScript,
    /lipo\s+"\$\{output_path\}"\s+-verify_arch\s+arm64\s+x86_64\s+\|\|\s+\{/
  );
  assert.match(buildScript, /MAC_ARCH="\$\{TUTTI_DESKTOP_MAC_ARCH:-all\}"/);
  assert.match(buildScript, /MAC_ARCH_ARGS=\(--x64 --arm64 --universal\)/);
  assert.match(buildScript, /MAC_ARCH_ARGS=\(--x64\)/);
  assert.match(buildScript, /MAC_ARCH_ARGS=\(--arm64\)/);
  assert.match(buildScript, /MAC_ARCH_ARGS=\(--universal\)/);
  assert.match(
    buildScript,
    /electron-builder --mac "\$\{MAC_ARCH_ARGS\[@\]\}"/
  );
  // The native claude binaries are provisioned at runtime by tuttid
  // (services/tuttid/service/agentstatus/claude_binary.go); the vendored
  // sidecar bundle must stay JS-only so every architecture ships identical
  // resources and no Mach-O merging exemption is needed.
  assert.doesNotMatch(buildScript, /--include-darwin-native-packages/);
  assert.match(claudeSidecarVendorScript, /--omit=optional/);
  assert.doesNotMatch(claudeSidecarVendorScript, /"pack"/);
  assert.equal(
    packageJson.build.mac.x64ArchFiles,
    undefined,
    "the sidecar bundle carries no native binaries, so no x64ArchFiles exemption may exist"
  );
});

test("desktop release workflow opts JavaScript actions into Node 24", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /FORCE_JAVASCRIPT_ACTIONS_TO_NODE24:\s*true/);
  assert.doesNotMatch(workflow, /actions\/checkout@v4/);
  assert.doesNotMatch(workflow, /actions\/setup-node@v4/);
  assert.doesNotMatch(workflow, /actions\/setup-go@v5/);
  assert.doesNotMatch(workflow, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(workflow, /pnpm\/action-setup@v4/);
});

test("desktop package declares the workspace package manager for electron-builder", async () => {
  const packageJson = JSON.parse(await readFile(desktopPackagePath, "utf8"));

  assert.equal(packageJson.packageManager, "pnpm@10.11.0");
});

test("desktop release pins the supported Electron platform contract", async () => {
  const packageJson = JSON.parse(await readFile(desktopPackagePath, "utf8"));
  const workflow = await readFile(workflowPath, "utf8");

  assert.equal(packageJson.devDependencies.electron, "^43.2.0");
  assert.equal(packageJson.build.mac.minimumSystemVersion, "12.0.0");
  assert.match(workflow, /name:\s+Install Electron runtime/);
  assert.match(
    workflow,
    /run:\s+pnpm --filter @tutti-os\/desktop exec install-electron/
  );
});

test("desktop package verifies channel-specific prerelease updater metadata", async () => {
  const packageJson = JSON.parse(await readFile(desktopPackagePath, "utf8"));
  const workflow = await readFile(workflowPath, "utf8");

  assert.equal(packageJson.build?.generateUpdatesFilesForAllChannels, true);
  assert.match(workflow, /Verify prerelease updater metadata/);
  assert.match(
    workflow,
    /needs\.resolve\.outputs\.release_channel\s*!=\s*'stable'/
  );
  assert.match(
    workflow,
    /updater_metadata="apps\/desktop\/dist\/\$\{TUTTI_DESKTOP_RELEASE_CHANNEL\}-mac\.yml"/
  );
  assert.match(workflow, /matrix:\s*\n\s*arch:\s*\[x64, arm64, universal\]/);
  assert.match(
    workflow,
    /name:\s+Merge macOS release artifacts and updater metadata/
  );
  assert.match(
    workflow,
    /node apps\/desktop\/scripts\/merge-macos-release-artifacts\.mjs/
  );
  assert.doesNotMatch(workflow, /cp apps\/desktop\/dist\/latest-mac\.yml/);
});

test("desktop package uses a distinct product identity from tsh desktop", async () => {
  const packageJson = JSON.parse(await readFile(desktopPackagePath, "utf8"));

  assert.equal(packageJson.productName, "Tutti");
  assert.equal(packageJson.build.productName, "Tutti");
  assert.equal(packageJson.build.executableName, "Tutti");
});

test("desktop package ships ws as a runtime dependency for packaged main-process imports", async () => {
  const packageJson = JSON.parse(await readFile(desktopPackagePath, "utf8"));

  assert.equal(
    packageJson.dependencies.ws,
    "^8.21.0",
    "packaged desktop apps need ws in production dependencies because the main process requires it at runtime"
  );
  assert.equal(
    packageJson.devDependencies.ws,
    undefined,
    "ws should not live only in devDependencies or packaged apps will miss it"
  );
});

test("desktop release docs describe same-architecture macOS updater preference", async () => {
  const releaseDocsPath = new URL(
    "../../docs/conventions/desktop-release.md",
    import.meta.url
  );
  const releaseDocs = await readFile(releaseDocsPath, "utf8");

  assert.match(
    releaseDocs,
    /macOS auto-update metadata must keep x64, arm64, and universal zip entries/
  );
  assert.match(
    releaseDocs,
    /electron-updater should download the same-architecture zip first/
  );
});

test("desktop electron-vite config bundles ws into the packaged main process", async () => {
  const electronViteConfig = await readFile(electronViteConfigPath, "utf8");

  assert.match(
    electronViteConfig,
    /exclude:\s*\[[\s\S]*"ws"[\s\S]*\]/,
    "ws must stay excluded from runtime externalization so packaged apps bundle it into the main-process output"
  );
});

test("desktop electron-vite config disables bundled ws optional native dependencies", async () => {
  const electronViteConfig = await readFile(electronViteConfigPath, "utf8");

  assert.match(
    electronViteConfig,
    /const\s+bundledWsDefines\s*=\s*\{[\s\S]*process\.env\.WS_NO_BUFFER_UTIL[\s\S]*process\.env\.WS_NO_UTF_8_VALIDATE[\s\S]*\}/,
    "bundled ws optional native dependency defines must stay grouped together"
  );
  assert.match(
    electronViteConfig,
    /main:\s*\{[\s\S]*define:\s*bundledWsDefines[\s\S]*plugins:\s*\[externalizeRuntimeDeps\]/,
    "bundled ws must not emit a startup-time bufferutil resolution stub"
  );
  assert.match(
    electronViteConfig,
    /preload:\s*\{[\s\S]*define:\s*bundledWsDefines[\s\S]*plugins:\s*\[[\s\S]*externalizeRuntimeDeps[\s\S]*\]/,
    "bundled ws must not emit a startup-time utf-8-validate resolution stub"
  );
});

test("browser node guest preload stays self-contained for sandboxed webviews", async () => {
  const preloadEntry = await readFile(browserNodeGuestPreloadPath, "utf8");

  assert.doesNotMatch(
    preloadEntry,
    /shared\/contracts\/ipc/,
    "sandboxed webview guest preload must not import shared IPC contracts because Rollup may emit a required chunk"
  );
  assert.match(preloadEntry, /browser:guestOpenUrl/);
  assert.match(preloadEntry, /browser:guestDiagnostic/);
});

test("browser workbench loopback proxy uses static ws imports for bundleable desktop runtime code", async () => {
  const loopbackPreviewProxy = await readFile(loopbackPreviewProxyPath, "utf8");

  assert.doesNotMatch(
    loopbackPreviewProxy,
    /createRequire\(import\.meta\.url\)/,
    "desktop runtime code should avoid createRequire for ws so ESM main-process imports stay analyzable"
  );
  assert.doesNotMatch(
    loopbackPreviewProxy,
    /require\("ws"\)/,
    'desktop runtime code should avoid require("ws") so electron-vite can bundle the dependency into the packaged main process'
  );
  assert.match(
    loopbackPreviewProxy,
    /import WebSocket(?:,\s*\{\s*WebSocketServer\s*\})? from "ws"|import WebSocket,\s*\{\s*WebSocketServer\s*\} from "ws"/,
    "desktop runtime code should statically import ws entry points"
  );
});

test("workspace root declares package workspaces for electron-builder fallback discovery", async () => {
  const packageJson = JSON.parse(
    await readFile(workspaceRootPackagePath, "utf8")
  );

  assert.deepEqual(packageJson.workspaces, [
    "apps/*",
    "packages/*/*",
    "services/tuttid/builtin-apps/tutti-onboarding",
    "tools/fixtures/*"
  ]);
});

test("desktop packaging provides an application icon resource", async () => {
  await access(desktopBuildIconPath);
});

test("desktop windows packaging anchors electron-builder workspace detection to the repo root", async () => {
  const packageJson = JSON.parse(await readFile(desktopPackagePath, "utf8"));
  const buildScript = await readFile(buildScriptPath, "utf8");

  assert.match(buildScript, /npm_package_json="\$\{ROOT_DIR\}\/package\.json"/);
  assert.match(buildScript, /INIT_CWD="\$\{ROOT_DIR\}"/);
  assert.equal(
    packageJson.scripts["build:win:prepared"],
    "bash ../../tools/scripts/build-desktop-package.sh win --prepared-builtin-apps"
  );
  assert.match(buildScript, /--prepared-builtin-apps/);
  assert.match(buildScript, /BUILTIN_APPS_PREPARED/);
});

test("desktop Windows package and daemon agree on the managed POSIX shell resource", async () => {
  const packageJson = JSON.parse(await readFile(desktopPackagePath, "utf8"));
  const buildScript = await readFile(buildScriptPath, "utf8");
  const alphaWorkflow = await readFile(windowsAlphaWorkflowPath, "utf8");
  const tuttidManager = await readFile(tuttidManagerPath, "utf8");
  const lock = JSON.parse(await readFile(managedPosixShellLockPath, "utf8"));

  await access(managedPosixShellVendorScriptPath);
  assert.deepEqual(packageJson.build.win.extraResources, [
    {
      from: "build/managed-posix-shell",
      to: "bin/managed-posix-shell",
      filter: ["**/*"]
    },
    {
      from: "build/mutagen",
      to: "bin/mutagen",
      filter: ["**/*"]
    }
  ]);
  assert.match(buildScript, /vendor-managed-posix-shell\.mjs/);
  assert.match(alphaWorkflow, /managed-posix-shell/);
  assert.match(alphaWorkflow, /runtime\.json/);
  assert.match(alphaWorkflow, /shellMetadata\.executable/);
  assert.match(tuttidManager, /"managed-posix-shell"/);
  assert.match(tuttidManager, /TUTTI_MANAGED_POSIX_SHELL/);
  assert.match(tuttidManager, /runtime\.json/);
  assert.doesNotMatch(tuttidManager, /bash\.exe/);
  assert.equal(lock.schemaVersion, "tutti.managed-posix-shell-lock.v1");
  assert.equal(lock.platforms["windows-amd64"].executable, "usr/bin/bash.exe");
  assert.doesNotMatch(alphaWorkflow, /\n\s+push:/);
});

test("desktop Windows package and daemon agree on the bundled Mutagen resource", async () => {
  const packageJson = JSON.parse(await readFile(desktopPackagePath, "utf8"));
  const buildScript = await readFile(buildScriptPath, "utf8");
  const alphaWorkflow = await readFile(windowsAlphaWorkflowPath, "utf8");
  const tuttidManager = await readFile(tuttidManagerPath, "utf8");
  const lock = JSON.parse(await readFile(mutagenLockPath, "utf8"));

  await access(mutagenVendorScriptPath);
  assert.deepEqual(packageJson.build.win.extraResources[1], {
    from: "build/mutagen",
    to: "bin/mutagen",
    filter: ["**/*"]
  });
  assert.match(buildScript, /vendor-mutagen\.mjs/);
  assert.match(alphaWorkflow, /bin\/mutagen/);
  assert.match(alphaWorkflow, /mutagenMetadata\.executable/);
  assert.match(tuttidManager, /"mutagen"/);
  assert.match(tuttidManager, /TUTTI_MUTAGEN_BIN/);
  assert.match(tuttidManager, /tutti\.mutagen\.v1/);
  assert.equal(lock.schemaVersion, "tutti.mutagen-lock.v1");
  assert.equal(lock.platforms["windows-amd64"].executable, "mutagen.exe");
});

test("desktop packages and daemon agree on the bundled uv archive root", async () => {
  const packageJson = JSON.parse(await readFile(desktopPackagePath, "utf8"));
  const defaults = JSON.parse(
    await readFile(
      new URL("../../config/tutti.defaults.json", import.meta.url),
      "utf8"
    )
  );
  const buildScript = await readFile(buildScriptPath, "utf8");
  const tuttidManager = await readFile(tuttidManagerPath, "utf8");

  await access(managedUVVendorScriptPath);
  assert.deepEqual(packageJson.build.extraResources.at(-1), {
    from: "build/managed-uv",
    to: "bin/managed-uv",
    filter: ["**/*"]
  });
  assert.match(buildScript, /vendor-managed-uv\.mjs/);
  assert.match(buildScript, /windows-amd64/);
  assert.match(
    buildScript,
    /upstream macOS uv archives contain the uv and uvx executables/
  );
  assert.match(buildScript, /rm -rf "\$\{APP_DIR\}\/build\/managed-uv"/);
  assert.match(buildScript, /mkdir -p "\$\{APP_DIR\}\/build\/managed-uv"/);
  assert.match(tuttidManager, /TUTTI_BUNDLED_UV_ROOT/);
  assert.equal(defaults.agentRuntimeTools.uv.version, "0.11.31");
  assert.ok(defaults.agentRuntimeTools.uv.artifacts.length >= 5);
});
