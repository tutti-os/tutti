import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const desktopPackagePath = new URL(
  "../../apps/desktop/package.json",
  import.meta.url
);
const workspaceRootPackagePath = new URL("../../package.json", import.meta.url);
const workflowPath = new URL(
  "../../.github/workflows/desktop-release.yml",
  import.meta.url
);
const buildScriptPath = new URL(
  "../../tools/scripts/build-desktop-package.sh",
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

test("desktop release workflow publishes rc tags as prereleases and keeps stable tags as latest", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /push:\s*\n\s*tags:\s*\n\s*-\s*"v\*"/);
  assert.doesNotMatch(workflow, /-\s*"tutti-desktop-v\*"/);
  assert.match(workflow, /default:\s*patch_rc_release/);
  assert.match(
    workflow,
    /release_mode:[\s\S]*?options:\s*\n\s*-\s*unsigned_dry_run\n\s*-\s*patch_beta_release\n\s*-\s*patch_rc_release\n\s*-\s*patch_release\n\s*-\s*minor_release\n\s*-\s*major_release\n\s*-\s*explicit_version_release/
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

test("desktop release workflow reserves unique tags instead of serializing whole runs", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.doesNotMatch(workflow, /^concurrency:/m);
  assert.match(workflow, /apps\/desktop\/scripts\/reserve-release-tag\.mjs/);
  assert.match(
    workflow,
    /args\+=\(--target "\${{\s*steps\.target\.outputs\.release_target\s*}}"\)/
  );
});

test("desktop release workflow passes tsh-aligned Feishu card context", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /name:\s+Download built artifacts[\s\S]*pattern:\s+tutti-desktop-release-assets-macos/
  );
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
    /outputs:\s*\n\s*release_url:\s*\${{\s*steps\.stage-release\.outputs\.url\s*}}/
  );
  assert.match(
    workflow,
    /id:\s+stage-release\s*\n\s*name:\s+Stage GitHub release assets/
  );
  assert.match(
    workflow,
    /RELEASE_URL:\s+\${{\s*needs\.publish\.outputs\.release_url\s*}}/
  );
  assert.match(workflow, /RELEASE_ASSET_DIRECTORY:\s+release-assets/);
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

test("desktop release workflow downloads Feishu artifacts after checkout", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const notifyJobMatch = workflow.match(
    /notify-feishu:[\s\S]*?(?=\n\s{2}[a-z][a-z0-9_-]+:\n|$)/
  );

  assert.ok(notifyJobMatch, "notify-feishu job should exist");

  const notifyJob = notifyJobMatch[0];
  const checkoutIndex = notifyJob.indexOf("name: Checkout notification script");
  const setupNodeIndex = notifyJob.indexOf("name: Setup Node.js");
  const downloadIndex = notifyJob.indexOf("name: Download built artifacts");
  const sendIndex = notifyJob.indexOf("name: Send release card");

  assert.notEqual(checkoutIndex, -1, "notify job should checkout the script");
  assert.notEqual(setupNodeIndex, -1, "notify job should setup Node.js");
  assert.notEqual(downloadIndex, -1, "notify job should download artifacts");
  assert.notEqual(sendIndex, -1, "notify job should send the release card");
  assert.ok(
    checkoutIndex < downloadIndex,
    "checkout must run before artifact download because actions/checkout cleans the workspace"
  );
  assert.ok(setupNodeIndex < downloadIndex);
  assert.ok(downloadIndex < sendIndex);
});

test("desktop release workflow can mirror release assets to S3 and upsert direct download links", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /permissions:\s*\n\s*contents:\s*write\s*\n\s*id-token:\s*write/
  );
  assert.match(workflow, /Upload release assets to AWS S3/);
  assert.match(workflow, /aws-actions\/configure-aws-credentials@v4/);
  assert.match(
    workflow,
    /TUTTI_DESKTOP_RELEASE_ASSETS_BASE_URL=https:\/\/\${TUTTI_DESKTOP_RELEASE_ASSETS_S3_BUCKET}\.s3-accelerate\.amazonaws\.com\/\${TUTTI_DESKTOP_RELEASE_ASSETS_S3_PREFIX%\/}/
  );
  assert.match(
    workflow,
    /apps\/desktop\/scripts\/upsert-release-download-links\.mjs/
  );
  assert.match(workflow, /Build desktop release latest metadata/);
  assert.match(workflow, /apps\/desktop\/scripts\/build-release-latest\.mjs/);
  assert.match(
    workflow,
    /aws s3 cp release-latest\.json "\$\{s3_root\}\/latest\.json"/
  );
});

test("desktop release workflow only publishes root latest metadata for stable releases", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const latestBuildStep = workflow.match(
    /- name: Build desktop release latest metadata[\s\S]*?run: node apps\/desktop\/scripts\/build-release-latest\.mjs[^\n]*/
  )?.[0];
  const latestUploadStep = workflow.match(
    /- name: Upload desktop release latest metadata to AWS S3[\s\S]*?aws s3 cp release-latest\.json "\$\{s3_root\}\/latest\.json"/
  )?.[0];

  assert.ok(latestBuildStep, "latest metadata build step should exist");
  assert.ok(latestUploadStep, "latest metadata upload step should exist");
  assert.match(
    latestBuildStep,
    /needs\.resolve\.outputs\.release_make_latest\s*==\s*'true'/
  );
  assert.match(
    latestUploadStep,
    /needs\.resolve\.outputs\.release_make_latest\s*==\s*'true'/
  );
  assert.match(workflow, /Build desktop prerelease channel latest metadata/);
  assert.match(
    workflow,
    /needs\.resolve\.outputs\.release_channel\s*!=\s*'stable'/
  );
  assert.match(
    workflow,
    /channels\/preview\/latest\.json[\s\S]*channels\/rc\/latest\.json/
  );
  assert.match(workflow, /channels\/beta\/latest\.json/);
});

test("desktop release workflow publishes immutable updater files before channel pointers", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const publishJobMatch = workflow.match(
    /publish:[\s\S]*?(?=\n\s{2}[a-z][a-z0-9_-]+:\n|$)/
  );

  assert.ok(publishJobMatch, "publish job should exist");
  const publishJob = publishJobMatch[0];
  const assetsIndex = publishJob.indexOf(
    "name: Upload release assets to AWS S3"
  );
  const stableBuildIndex = publishJob.indexOf(
    "name: Build desktop release latest metadata"
  );
  const stablePointerIndex = publishJob.indexOf(
    "name: Upload desktop release latest metadata to AWS S3"
  );
  const rcBuildIndex = publishJob.indexOf(
    "name: Build desktop prerelease channel latest metadata"
  );
  const rcPointerIndex = publishJob.indexOf(
    "name: Upload desktop prerelease channel latest metadata to AWS S3"
  );

  assert.ok(assetsIndex >= 0, "immutable release assets should upload");
  assert.ok(stableBuildIndex > assetsIndex);
  assert.ok(stablePointerIndex > stableBuildIndex);
  assert.ok(rcBuildIndex > assetsIndex);
  assert.ok(rcPointerIndex > rcBuildIndex);
  assert.match(publishJob, /channels\/rc\/latest\.json/);
  assert.match(publishJob, /--cache-control "public, max-age=60"/);
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

  assert.match(workflow, /Generate desktop release summary/);
  assert.match(
    workflow,
    /apps\/desktop\/scripts\/generate-release-summary\.mjs/
  );
  assert.match(workflow, /secrets\.AGNES_API_KEY/);
  assert.match(workflow, /Upload desktop release summary artifact/);
  assert.match(workflow, /Update release notes with summary/);
  assert.match(workflow, /apps\/desktop\/scripts\/upsert-release-summary\.mjs/);
  assert.match(workflow, /Update desktop release changelog metadata/);
  assert.match(
    workflow,
    /apps\/desktop\/scripts\/upsert-release-changelog\.mjs/
  );
  assert.match(
    workflow,
    /grep -Eq "\(404\|NoSuchKey\|Not Found\)" changelog-download\.err/
  );
  assert.match(workflow, /"schemaVersion":"tutti\.desktop\.changelog\.v1"/);
  assert.match(workflow, /"\$\{s3_root\}\/changelog\.json"/);
  assert.match(workflow, /Download release summary/);
  assert.match(
    workflow,
    /RELEASE_SUMMARY_PATH:\s+release-summary\/release-summary\.json/
  );
});

test("desktop release workflow keeps prereleases as drafts and reserves the public list for stable", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const publishJobMatch = workflow.match(
    /publish:[\s\S]*?(?=\n\s{2}[a-z][a-z0-9_-]+:\n|$)/
  );

  assert.ok(publishJobMatch, "publish job should exist");
  const publishJob = publishJobMatch[0];
  const stageIndex = publishJob.indexOf("name: Stage GitHub release assets");
  const s3Index = publishJob.indexOf("name: Upload release assets to AWS S3");
  const notesIndex = publishJob.indexOf(
    "name: Update release notes with direct downloads"
  );
  const publishIndex = publishJob.indexOf(
    "name: Publish stable GitHub release"
  );
  const archiveIndex = publishJob.indexOf(
    "name: Archive public GitHub prereleases"
  );
  const stableAliasIndex = publishJob.indexOf(
    "name: Refresh stable release alias"
  );

  assert.notEqual(stageIndex, -1, "release assets should be staged");
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
  assert.match(publishJob, /draft:\s*true/);
  assert.match(
    publishJob,
    /gh release edit "\$\{TUTTI_DESKTOP_RELEASE_TAG\}" --draft=false/
  );
  assert.match(
    publishJob,
    /if:\s*\$\{\{\s*needs\.resolve\.outputs\.release_prerelease\s*!=\s*'true'\s*\}\}/
  );
  assert.match(
    publishJob,
    /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/releases\?per_page=100" --paginate/
  );
  assert.match(
    publishJob,
    /select\(\.prerelease and \(\.draft \| not\)\) \| \.id/
  );
  assert.match(
    publishJob,
    /gh api --method PATCH "repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$\{release_id\}"[\s\\]*-F draft=true/
  );
  assert.ok(stageIndex < s3Index);
  assert.ok(s3Index < notesIndex);
  assert.ok(notesIndex < publishIndex);
  assert.ok(publishIndex < archiveIndex);
  assert.ok(archiveIndex < stableAliasIndex);
});

test("desktop release workflow refreshes the stable alias without taking Latest", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const publishJobMatch = workflow.match(
    /publish:[\s\S]*?(?=\n\s{2}[a-z][a-z0-9_-]+:\n|$)/
  );

  assert.ok(publishJobMatch, "publish job should exist");
  const publishJob = publishJobMatch[0];
  const stableAliasStep = publishJob.match(
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

test("desktop release workflow publishes only macOS release assets for now", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const publishJobMatch = workflow.match(
    /publish:[\s\S]*?(?=\n\s{2}[a-z][a-z0-9_-]+:\n|$)/
  );
  const notifyJobMatch = workflow.match(
    /notify-feishu:[\s\S]*?(?=\n\s{2}[a-z][a-z0-9_-]+:\n|$)/
  );

  assert.ok(publishJobMatch, "publish job should exist");
  assert.ok(notifyJobMatch, "notify-feishu job should exist");
  assert.doesNotMatch(workflow, /\n\s{2}build-windows:\n/);
  assert.doesNotMatch(workflow, /\n\s{2}build-linux:\n/);
  assert.match(publishJobMatch[0], /needs:\s+\[resolve, build-macos\]/);
  assert.doesNotMatch(publishJobMatch[0], /build-windows|build-linux/);
  assert.match(
    publishJobMatch[0],
    /pattern:\s+tutti-desktop-release-assets-macos/
  );
  assert.doesNotMatch(
    publishJobMatch[0],
    /pattern:\s+tutti-desktop-release-assets-\*/
  );
  assert.match(
    notifyJobMatch[0],
    /pattern:\s+tutti-desktop-release-assets-macos/
  );
  assert.doesNotMatch(
    notifyJobMatch[0],
    /pattern:\s+tutti-desktop-release-assets-\*/
  );
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
  assert.match(buildScript, /electron-builder --mac --x64 --arm64 --universal/);
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
  const buildScript = await readFile(buildScriptPath, "utf8");

  assert.match(buildScript, /npm_package_json="\$\{ROOT_DIR\}\/package\.json"/);
  assert.match(buildScript, /INIT_CWD="\$\{ROOT_DIR\}"/);
});
