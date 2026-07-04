# 桌面端 release / pre-release 渠道规划

日期：2026-07-03

## 背景

本规划参考
`/Users/wwcome/work/tutti-lab/tsh-commerce/docs/mac-installer-release-flow.md`
里的 Mac 安装包发布规则，并结合 Tutti 当前桌面端发布流水线现状。

核心目标：

- 对外用户始终下载稳定 release 包。
- 内部 QA / 开发者可以频繁发布和验证 pre-release / RC 包。
- 开发分支可以发布独立 beta 包，用于更早期验证，但不影响 RC 验收线和稳定
  `release/latest`。
- 自动更新默认走稳定 release 渠道。
- 已验收通过的 RC commit 可以重新触发正式 release 打包。

## 当前现状

- `.github/workflows/desktop-release.yml` 已经会区分：
  - `release_prerelease`
  - `release_make_latest`
- GitHub Release 发布步骤已经使用这两个值：
  - stable release 会设置为 GitHub Latest。
  - RC / pre-release 不会设置为 GitHub Latest。
- 但是 S3 / CloudFront 侧的根目录 `latest.json` 目前没有区分 stable 和
  pre-release。
- 只要配置了 `TUTTI_DESKTOP_RELEASE_ASSETS_BASE_URL`，workflow 就会生成
  `release-latest.json`，并上传为 S3 prefix 根目录下的 `latest.json`。
- 这意味着：当前 RC / pre-release 也可能覆盖公共下载入口使用的
  `latest.json`。
- 桌面端偏好里已经有 `updateChannel`：
  - `stable`
  - `rc`
- 自动更新服务也已经根据 channel 做区分：
  - `stable` 使用 `channel="latest"`，且 `allowPrerelease=false`
  - `rc` 使用 `channel="rc"`，且 `allowPrerelease=true`
- 但开发者设置 UI 里目前没有明显的 release channel 选择控件。
- 当前 workflow 已经支持 `target_commitish`，所以可以从某个 RC tag 或 commit
  重新打正式包。

## 渠道识别规则

需要把 “stable / rc / beta” 拆成三层来识别，避免把 GitHub Latest、
electron-updater channel 和 S3 `latest.json` 混成一个概念。

### 发布流水线识别

发布流水线的源头是 release version / tag：

- stable：版本是纯 semver，例如 `1.2.4`，对应 tag `v1.2.4`。
- rc：版本带 `-rc.N`，例如 `1.2.4-rc.1`，对应 tag `v1.2.4-rc.1`。
- beta：版本带 `-beta.N`，例如 `1.2.4-beta.1`，对应 tag
  `v1.2.4-beta.1`。它用于开发分支或更早期内部验证。

当前 `resolveDesktopRelease` 会解析版本：

- `channel === "stable"` 表示 stable。
- `channel === "rc"` 表示 RC pre-release。
- `channel === "beta"` 表示 beta pre-release。

因此它会输出：

- stable：`prerelease=false`，`makeLatest=true`。
- rc：`prerelease=true`，`makeLatest=false`。
- beta：`prerelease=true`，`makeLatest=false`。

GitHub Release 发布步骤再用这两个值设置：

- `prerelease`
- `make_latest`

所以 GitHub 侧的 stable / rc / beta 识别，核心不是看 workflow 名字，而是看最终解析出来的
release tag 是否是纯 semver、`-rc.N` 或 `-beta.N`。

### 自动更新客户端识别

客户端识别的是用户当前选择的 `updateChannel` 偏好：

- `stable`
- `rc`
- `beta` 目前先不暴露给普通开发者设置，只作为发布流水线里的独立打包通道；如果后续需要
  beta 用户自动追更，再把它作为开发者设置里的第三个 opt-in 选项。

更新服务会把它映射成 electron-updater 的配置：

- `stable` -> `channel="latest"`，`allowPrerelease=false`
- `rc` -> `channel="rc"`，`allowPrerelease=true`
- `beta` -> `channel="beta"`，`allowPrerelease=true`

如果走 GitHub releases feed fallback，则再按 tag 版本过滤：

- `stable` 只接受没有 prerelease 的版本，例如 `1.2.4`。
- `rc` 只接受 prerelease 第一段是 `rc` 的版本，例如 `1.2.4-rc.1`。
- `beta` 只接受 prerelease 第一段是 `beta` 的版本，例如 `1.2.4-beta.1`。

这里的 `latest` 是 electron-updater 的稳定更新 channel 名，不等于 S3 根目录的
`latest.json` 文件；两者名字相近，但要分开看。

### electron-updater GitHub provider 行为

当前项目使用 `electron-updater@6.8.3`，GitHub provider 的内部行为可以概括为：

- `allowPrerelease=false` 时：
  - 不遍历 pre-release。
  - 直接走 GitHub latest release。
  - 只要 GitHub Release 的 `make_latest` 没有被 pre-release 覆盖，stable 用户不会收到
    RC / beta。
- `allowPrerelease=true` 时：
  - 会读取 GitHub releases Atom feed。
  - 如果显式设置了 `autoUpdater.channel = "rc"`，它会按 tag 的 semver prerelease
    第一段筛选，即只接受 `*-rc.*`。
  - 如果显式设置了 `autoUpdater.channel = "beta"`，逻辑同理，只接受 `*-beta.*`。
  - 找到 RC / beta tag 后，会优先读取该 tag 下的 `rc-mac.yml` / `beta-mac.yml`。
  - 如果找不到对应 channel yaml，在 `allowPrerelease=true` 时会 fallback 到同一个
    tag 下的 `latest-mac.yml` / `latest.yml`。

这说明：

- stable 侧依赖 GitHub Latest 是合理的。
- pre-release 侧不能只说 “设置 channel=rc/beta 就万事大吉”，还要保证对应 release
  资产里有正确的 update yaml。
- 如果暂时只有 `latest-mac.yml`，RC 更新仍可能因为 fallback 可用，但这不是清晰契约。
- 更稳妥的做法是发布 pre-release 时显式生成 / 上传 `${channel}-mac.yml`。dry-run
  验证发现当前 electron-builder macOS 产物只生成 `latest-mac.yml`，所以 workflow
  需要在 RC 构建后把它物化为 `rc-mac.yml`，在 beta 构建后物化为 `beta-mac.yml`，
  并继续上传 `apps/desktop/dist/*.yml`。

需要在实现阶段确认 electron-builder 的 RC 产物：

- `v1.2.4-rc.1` 是否上传了 `rc-mac.yml`。
- 如果只上传 `latest-mac.yml`，要么显式设置 GitHub publish `channel: "rc"`，要么把
  “RC fallback 到 latest-mac.yml” 作为已知兼容路径写进测试。
- 不能让 stable 用户设置 `allowPrerelease=true`；否则 GitHub provider 会开始读取
  prerelease feed。

### 公共下载入口识别

公共下载入口不应该根据“最新上传过什么”来判断，而应该根据受保护的
`latest.json` contract 判断。

首期规则：

- 只有 stable release 可以写 S3 根目录 `latest.json`。
- RC / beta 可以上传到不可变 tag 目录，但不能覆盖根目录 `latest.json`。
- worker 读取 `latest.json` 后，还要校验：
  - `channel === "stable"`
  - `prerelease === false`
  - `version` 是纯 semver
  - `tag` 不带 `-rc.N` / `-beta.N`
  - 下载 URL 指向当前 stable tag 目录

所以公共下载入口的 stable 识别应该是“双保险”：

1. 发布流水线只允许 stable 写公共 `latest.json`。
2. worker 读取后再校验 metadata，异常就 fail closed。

## 总体决策

公共 `latest.json` 必须只代表稳定 release。

pre-release / RC / beta 包可以上传到 S3 的不可变 tag 目录，供内部 QA 或开发分支验证通过固定链接下载，
但不能覆盖 S3 根目录的公共 `latest.json`。

Cloudflare download worker 也应该做防御校验：如果读到的 `latest.json` 是
pre-release，就不能把它作为对外下载地址返回。不过 worker 只是兜底防线，主防线
应该放在发布流水线里。

新增 beta 的定位：

- beta 是比 RC 更早的开发验证包。
- beta 发布为 GitHub Pre-release。
- beta 可以上传 S3 tag 不可变目录，方便固定链接下载。
- beta 不写公共 `latest.json`。
- beta 不写公共 `changelog.json`。
- beta 不影响 RC 的 `rc-mac.yml` 和 RC 自动更新通道。
- beta 不默认暴露到客户端设置；只有需要 beta 自动追更时再单独加第三个 opt-in。

## 问题 1：download worker 和 S3 `latest.json` 怎么改

推荐规则：

- stable release：
  - 发布为 GitHub 正式 Release。
  - 设置为 GitHub Latest。
  - 上传 release assets 到 S3 tag 目录。
  - 生成并上传 S3 根目录 `latest.json`。
  - Cloudflare download worker 返回这个稳定包下载地址。
- pre-release / RC / beta：
  - 发布为 GitHub Pre-release。
  - 不设置 GitHub Latest。
  - 可以上传 release assets 到 S3 tag 目录。
  - 不更新 S3 根目录 `latest.json`。

需要改造：

1. 在 `.github/workflows/desktop-release.yml` 里给这两个步骤加 stable-only 条件：
   - `Build desktop release latest metadata`
   - `Upload desktop release latest metadata to AWS S3`
2. 条件建议使用：

   ```text
   env.TUTTI_DESKTOP_RELEASE_ASSETS_BASE_URL != '' &&
   needs.resolve.outputs.release_make_latest == 'true'
   ```

3. 增加 workflow 文本测试，防止后续又让 RC 覆盖公共 `latest.json`。
4. 更新 `docs/conventions/desktop-release.md`，明确：
   - S3 根目录 `latest.json` 是稳定 release 渠道。
   - RC / pre-release 不能更新它。
5. Cloudflare worker 侧增加校验：
   - 校验 schema version。
   - 校验 `version` 是纯 semver，不带 `-rc` / `-beta`。
   - 校验 `channel === "stable"`。
   - 校验 `prerelease === false`。
   - 校验 `tag` 和 `version` 一致，例如 `v1.2.4` 对应 `1.2.4`。
   - 优先选择 macOS universal `.dmg`。
   - metadata 异常时 fail closed，不能返回 pre-release 包。

结论：两边都要做。发布流水线不让 pre-release 写入公共 `latest.json`，worker 再做
兜底防御。

`latest.json` 建议补充 stable 判定字段，让 worker 不只靠 semver 推断：

```json
{
  "schemaVersion": "tutti.desktop.release.latest.v1",
  "tag": "v1.2.4",
  "version": "1.2.4",
  "channel": "stable",
  "prerelease": false,
  "releasedAt": "2026-07-04T12:00:00.000Z",
  "gitSha": "537327a...",
  "sourceRef": "main",
  "baseUrl": "https://<cdn-host>/<prefix>",
  "preferredDownloads": {
    "macosUniversalDmg": "https://<cdn-host>/<prefix>/v1.2.4/Tutti-1.2.4-mac-universal.dmg"
  },
  "assets": []
}
```

worker 的 stable 判定必须同时满足 schema、`channel`、`prerelease`、纯 semver、
tag/version 一致、首选下载地址存在并指向当前 tag 目录。任何一项不满足都不要返回对外
下载地址。

## 问题 2：自动更新默认走 stable 还是 pre-release

推荐默认：

- 普通用户 / 对外安装包默认使用 `stable`。
- 如果本地还没有保存过更新偏好，首次默认值跟随当前包版本：
  - 正式包默认检测 `stable`。
  - RC 包默认检测 `rc`，用于内部验收继续收到后续 RC。
  - beta 包首期仍默认检测 `stable`，因为 beta 自动更新还不暴露给客户端设置。
- 内部 QA / 开发者可以在开发者设置里切换到 `rc`。
- beta 首期只作为 CI 独立打包通道，不进入客户端设置。
- stable 渠道只检测稳定 release。
- rc 渠道允许检测 pre-release / RC。
- beta 渠道如果以后暴露，则只检测 `-beta.N` 包，不读取 stable latest。

如果 RC 包也检测 stable latest，会不会冲突？

通常不会。

例如：

- 当前版本是 `1.2.4-rc.1`
- stable latest 是 `1.2.4`

语义版本里 `1.2.4` 会被认为比 `1.2.4-rc.1` 新，所以 RC 包升级到正式包是合理的。

再比如：

- 当前版本是 `1.2.5-rc.1`
- stable latest 是 `1.2.4`

因为 updater 设置了 `allowDowngrade=false`，所以不应该降级。

真正的问题是：如果 RC 用户也只看 stable latest，他们就收不到后续 RC 包。因此内部
验收如果需要频繁收 RC 更新，就应该保留 `rc` 作为 opt-in 渠道。

需要改造：

1. 把默认 update channel 改成按当前包版本推导：正式包 `stable`，RC 包 `rc`，beta 包暂时
   `stable`。
2. 保留 `rc` 作为内部 opt-in 渠道。
3. 在开发者设置里增加一个 release channel 控件：

   ```text
   Release channel

   [Stable release] [Pre-release / RC]
   ```

4. 这个控件直接接现有的 `updateChannel` 偏好，不新增第二套设置。
5. 对老版本已经因为旧默认值写入的 `rc` 做一次性迁移，拉回 `stable`。
   迁移 marker 写入后，用户再从开发者设置手动选择 `rc`，后续就视为显式 opt-in 并保留。
   RC 包自身的首次默认 `rc` 不执行这次拉回。
6. 增加测试：
   - 正式包首次默认偏好是 `stable`。
   - RC 包首次默认偏好是 `rc`。
   - beta 包首次默认偏好仍是 `stable`。
   - stable 会配置为 `channel="latest"` + `allowPrerelease=false`。
   - rc 会配置为 `channel="rc"` + `allowPrerelease=true`。
   - GitHub release fallback 对 stable / rc 的过滤符合预期。
7. 更新 `docs/conventions/desktop-release.md`：
   - 不再写成 “stable channel only”。
   - 改成 “stable 是公共默认渠道，rc 是内部 opt-in 渠道”。

RC 自动更新源需要明确：

- stable 自动更新只读稳定 release metadata。
- rc 自动更新继续走 GitHub pre-release / electron-updater 的 `rc` channel，不读取公共
  S3 根目录 `latest.json`。
- RC 发布会额外写入 CDN channel latest：
  - `channels/preview/latest.json`
  - `channels/rc/latest.json`
- `preview` 是面向使用者的名字，内部语义等同于 RC。
- 这些 channel latest 不能复用或覆盖公共根目录 `latest.json`。

beta 自动更新源首期不新增：

- beta 的首要用途是开发分支独立打包和固定链接验收。
- beta tag 使用 `vX.Y.Z-beta.N`，GitHub Release 保持 Pre-release。
- workflow 会上传 `beta-mac.yml`，保证未来需要 beta 自动更新时已有清晰契约。
- beta 发布会额外写入 `channels/beta/latest.json`，供显式 beta 下载入口读取。
- 但客户端开发者设置先不展示 beta，避免普通内部用户把自己切到过早期包。
- 如果后续需要 beta 用户持续追更，再补一个显式的 beta opt-in 控件，并把
  `updateChannel="beta"` 映射到 electron-updater `channel="beta"`。

既有用户迁移需要单独处理：

- 正式包首次启动、且没有已保存偏好时默认 `stable`。
- RC 包首次启动、且没有已保存偏好时默认 `rc`。
- beta 包首次启动仍默认 `stable`，避免开发分支包进入持续自动更新链路。
- 已显式选择过 `rc` 的内部用户保留 `rc`。
- 如果历史上有“默认迁到 rc”的 marker，需要识别这是系统默认还是用户显式选择。
- 稳定包上没有迁移 marker 的历史 `rc` 默认值会被一次性拉回 `stable`；迁移 marker
  写入后，开发者设置中的手动选择会继续保留。
- 迁移逻辑和测试要覆盖：新安装、已有 rc、已有 stable、旧 marker 四种情况。

## 问题 3：RC 验收通过后，如何转成正式 release

最简单的常规操作：

1. 当前最新正式版是 `v1.2.3`。
2. QA 验收通过 `v1.2.4-rc.1`。
3. 手动触发 `.github/workflows/desktop-release.yml`。
4. `release_mode` 选择 `patch_release`。
5. `target_commitish` 填 `v1.2.4-rc.1`，或者填这个 tag 对应的 commit SHA。
6. workflow 会从 RC 那份代码打包，并发布正式版 `v1.2.4`。

也就是说：

```text
release_mode: patch_release
target_commitish: v1.2.4-rc.1
```

这种方式适合 “当前最新 stable 是 `v1.2.3`，我要把 RC 转成下一版 patch
stable `v1.2.4`” 的场景。

需要注意：

- `patch_release` 负责自动计算下一个 patch 版本。
- `target_commitish` 负责决定从哪份代码打包。
- `target_commitish` 可以是 commit SHA，也可以是 tag。
- 如果 `target_commitish` 是 RC tag，workflow 应解析这个 tag 指向的 commit，并在
  summary、飞书和 GitHub Release body 里标注来源 RC。
- stable tag 创建后应校验 stable tag 和 source RC tag 指向同一个 commit，避免误填
  branch 或漂移 ref 后发布了不同代码。

如果版本必须精确指定，使用：

```text
release_mode: explicit_version_release
version: 1.2.4
target_commitish: v1.2.4-rc.1
```

什么时候要用 `explicit_version_release`？

- 当 `v1.2.4` 已经存在，`patch_release` 会自动算成 `v1.2.5`。
- 当你不希望 workflow 自动推导版本，而是明确指定版本。
- 当要从某个历史 commit 打一个指定正式版本。

不要把 `v1.2.4-rc.1` 直接改成正式包。正式发布应该重新创建稳定 tag，让 app
version、安装包文件名、updater metadata、release notes 都显示 `1.2.4`，而不是
`1.2.4-rc.1`。

## 关于“使用包版本打 release”

当前不建议把 `apps/desktop/package.json` 里的 version 当作 CI release 的来源。

原因：

- 源码里的 desktop package version 通常是 `0.0.0`。
- CI 打包时会根据 release tag 临时写入真实版本。
- 当前 source of truth 是 workflow 的 release version / release tag，不是源码中的
  package.json version。

如果以后确实需要“读取 target ref 里的 package.json version 并用它发布”，应该新增一个
明确的 workflow mode，例如 `package_version_release`，不要复用
`explicit_version_release`。

## 问题 4：增加 LLM 发布摘要和版本更新日志

需要增加。

现在飞书卡片主要告诉人“发布完成”和“去哪里下载”，但缺少一段让人马上读懂的
change list。发布通知面向内部协作，最有价值的是：

- 这次变了什么？
- 对用户有什么影响？
- QA 应该重点看什么？
- 如果是 RC，和上一个 RC / stable 相比差异在哪里？
- 如果是正式版，是否可以对外发布？

因此建议新增一个独立的 release summary 模块，而不是把总结逻辑塞进飞书脚本里。

### 产物设计

每次 release 生成一个结构化 summary 文件即可：

```text
release-summary.json
```

这个文件同时包含中文、英文和 changelog entry。飞书、GitHub Release body、长期
changelog 都从同一个文件读取，避免同一版本拆成多个小文件后不好管理。首期展示策略是：
飞书使用中文，GitHub Release body 使用英文。

建议字段：

```json
{
  "version": "v1.2.4",
  "channel": "stable",
  "compare": {
    "base": "v1.2.3",
    "head": "v1.2.4"
  },
  "summary": {
    "zh-CN": {
      "headline": "本次版本聚焦桌面发布链路稳定性。",
      "sections": [
        {
          "title": "功能优化",
          "kind": "improvement",
          "items": [
            {
              "text": "稳定包下载入口只指向正式 release，避免 RC 包被外部用户下载。",
              "scopes": ["release", "download"]
            }
          ]
        },
        {
          "title": "Bug Fix",
          "kind": "fix",
          "items": [
            {
              "text": "修复自动更新安装流程，减少 macOS 更新后未正确安装的情况。",
              "scopes": ["desktop", "update"]
            }
          ]
        }
      ],
      "qaFocus": ["验证 macOS 首次安装、从旧版本升级、以及外部下载入口。"],
      "risks": ["如果 CloudFront 缓存未刷新，下载入口可能短暂指向旧版本。"]
    },
    "en": {
      "headline": "This release focuses on desktop release reliability.",
      "sections": [
        {
          "title": "Improvements",
          "kind": "improvement",
          "items": [
            {
              "text": "Stable download links now point only to stable releases, preventing RC builds from reaching external users.",
              "scopes": ["release", "download"]
            }
          ]
        },
        {
          "title": "Bug Fixes",
          "kind": "fix",
          "items": [
            {
              "text": "Fixed the app update install flow to reduce failed macOS update installs.",
              "scopes": ["desktop", "update"]
            }
          ]
        }
      ],
      "qaFocus": ["Verify fresh macOS install, upgrade from an older build, and external download links."],
      "risks": ["Download links may briefly point to the previous version while CDN caches expire."]
    }
  },
  "markdown": {
    "zh-CN": "## 更新摘要\n\n### 功能优化\n\n- 稳定包下载入口只指向正式 release，避免 RC 包被外部用户下载。\n\n### Bug Fix\n\n- 修复自动更新安装流程，减少 macOS 更新后未正确安装的情况。\n",
    "en": "## Release Summary\n\n### Improvements\n\n- Stable download links now point only to stable releases, preventing RC builds from reaching external users.\n\n### Bug Fixes\n\n- Fixed the app update install flow to reduce failed macOS update installs.\n"
  },
  "changelogEntry": {
    "markdown": "## v1.2.4 - 2026-07-04\n\nChannel: stable\nCompare: v1.2.3...v1.2.4\n\n### 中文\n\n#### 功能优化\n\n- 稳定包下载入口只指向正式 release，避免 RC 包被外部用户下载。\n\n#### Bug Fix\n\n- 修复自动更新安装流程，减少 macOS 更新后未正确安装的情况。\n\n### English\n\n#### Improvements\n\n- Stable download links now point only to stable releases, preventing RC builds from reaching external users.\n\n#### Bug Fixes\n\n- Fixed the app update install flow to reduce failed macOS update installs.\n"
  }
}
```

### S3 / CDN 存储方式

首期只把全量 changelog feed 作为稳定的 CDN 契约。

如果 release asset base URL 是：

```text
https://<cdn-host>/<desktop-release-assets-prefix>
```

则网页 changelog 只读取：

```text
s3://<bucket>/<prefix>/changelog.json
https://<cdn-host>/<prefix>/changelog.json
```

`release-summary.json` 仍然可以在 workflow 内部生成，但首期只作为本次发布的临时
artifact 使用：

- 飞书卡片读取它，展示中文摘要。
- GitHub Release body 读取它，写入英文摘要。
- stable release 用它 upsert `/changelog.json`。

首期不要把每个版本的 `/<tag>/release-summary.json` 作为公开 CDN 契约，也不要维护
`/summaries/latest.json`。原因是：

- 全量页面已经有 `/changelog.json`。
- 最新 stable 信息可以从 `/changelog.json` 的第一条 stable version 得到。
- 少维护两个公开入口，可以降低缓存、权限和数据一致性的复杂度。

如果以后确实需要单版本详情直链或产品内“最新版本摘要”接口，再补充：

```text
/<tag>/release-summary.json
/summaries/latest.json
```

但这不是首期必要项。

### 全量 changelog 页面

如果以后要做类似 OpenCode / Apifox 那样的网页更新日志，需要一个聚合 feed。

推荐新增一个可变文件：

```text
s3://<bucket>/<prefix>/changelog.json
https://<cdn-host>/<prefix>/changelog.json
```

`changelog.json` 用于前端一次性拉取所有版本的更新日志。因为桌面端版本数量和单条内容都
不会太大，这个文件可以直接包含所有稳定版本的展示内容，不需要分页。

建议结构：

```json
{
  "schemaVersion": "tutti.desktop.changelog.v1",
  "generatedAt": "2026-07-04T12:00:00.000Z",
  "product": "Tutti Desktop",
  "localeDefault": "zh-CN",
  "versions": [
    {
      "tag": "v1.2.4",
      "version": "1.2.4",
      "channel": "stable",
      "releasedAt": "2026-07-04",
      "zh-CN": {
        "headline": "本次版本聚焦桌面发布链路稳定性。",
        "sections": [
          {
            "title": "功能优化",
            "kind": "improvement",
            "items": [
              {
                "text": "稳定包下载入口只指向正式 release，避免 RC 包被外部用户下载。",
                "scopes": ["release", "download"]
              }
            ]
          },
          {
            "title": "Bug Fix",
            "kind": "fix",
            "items": [
              {
                "text": "修复自动更新安装流程，减少 macOS 更新后未正确安装的情况。",
                "scopes": ["desktop", "update"]
              }
            ]
          }
        ]
      },
      "en": {
        "headline": "This release focuses on desktop release reliability.",
        "sections": [
          {
            "title": "Improvements",
            "kind": "improvement",
            "items": [
              {
                "text": "Stable download links now point only to stable releases, preventing RC builds from reaching external users.",
                "scopes": ["release", "download"]
              }
            ]
          },
          {
            "title": "Bug Fixes",
            "kind": "fix",
            "items": [
              {
                "text": "Fixed the app update install flow to reduce failed macOS update installs.",
                "scopes": ["desktop", "update"]
              }
            ]
          }
        ]
      }
    }
  ]
}
```

前端展示逻辑：

- 访问 `/changelog` 页面时请求 `changelog.json`。
- 按 `releasedAt` 或 semver 倒序渲染版本。
- 每个版本展示版本号、日期、headline、分组 changelist。
- 可以提供锚点，例如 `#v1.2.4`，方便飞书或 Release 页面跳转到某个版本。
- 中文页面读取 `zh-CN`，英文页面读取 `en`。

分组方式建议按“用户感知的变更类型”作为主分组，而不是按内部模块主分组。

推荐主分组：

```text
新功能
功能优化
Bug Fix
性能优化
开发者 / 发布
已知问题
```

这样更接近用户在 changelog 页面上的阅读习惯：先知道这次是新增能力、体验优化还是修复
问题。内部模块信息可以作为条目的 `scopes` / `tags`，用于筛选或辅助排查，但不要作为
默认展示的第一层标题。

例如：

```json
{
  "title": "功能优化",
  "kind": "improvement",
  "items": [
    {
      "text": "Agent 对话和协作更顺了：导入的会话、不同 Agent 的消息状态和长对话里的定位更稳定。",
      "scopes": ["agent", "conversation"]
    },
    {
      "text": "桌面端使用体验继续打磨：设置项、窗口吸附和日常操作减少小摩擦。",
      "scopes": ["desktop", "settings"]
    }
  ]
}
```

如果是内部 QA 视角，可以在 `release-summary.json` 里额外保留模块字段：

```json
{
  "text": "稳定包下载入口只指向正式 release。",
  "kind": "fix",
  "scopes": ["release", "download"],
  "qaFocus": true
}
```

页面默认按 `kind` 展示；需要排查时再按 `scopes` 过滤。

首期只把 `/changelog.json` 作为网页 changelog 的公开数据源。单版本 summary 和 latest
summary 指针都先不做公开 CDN 契约。

`changelog.json` 的更新方式：

1. 每次 stable release 在 workflow 内生成本版本 `release-summary.json`。
2. workflow 下载当前已有的 `/changelog.json`。
3. 用本版本 summary upsert 一条版本记录。
4. 按版本倒序重新写回 `/changelog.json`。
5. RC 默认不写入公开 `/changelog.json`，除非明确要展示 pre-release 历史。

`changelog.json` 是可变文件，必须定义并发和失败语义：

- release workflow 对 stable 发布使用 GitHub Actions concurrency，避免两个 stable
  发布同时改写 `/changelog.json` 导致丢记录。
- upsert 必须按 `tag` 幂等：同一个 tag 重跑只更新同一条记录，不追加重复版本。
- 如果远端 `changelog.json` 不存在，创建空列表后写入当前 stable。
- 写回前后都要做 schema 校验；不合法时不要覆盖远端文件。
- S3 写入建议使用较短缓存，例如 `Cache-Control: public, max-age=60`。
- 如果 CloudFront 需要更快可见，stable release 后对 `/changelog.json` 做 invalidation；
  否则接受最长约 60 秒延迟。
- 首期实现里 `changelog.json` 写入发生在正式发布 GitHub Release 之前；如果写入失败，
  workflow 应失败并保持 release draft 状态，避免外部 release 已可见但 changelog
  尚未同步。
- 重跑 stable release 的 publish/repair 流程时，应能重新生成 summary 并修复
  `/changelog.json`。

如果以后版本很多，再考虑拆分页：

```text
changelog/index.json
changelog/2026.json
changelog/2025.json
```

当前阶段不需要这么复杂，一个根目录 `changelog.json` 足够。

飞书卡片只展示中文，但不能太短。它应该让群里的人不用点链接也能大致看懂本次做了什么。
摘要应优先面向用户和 QA，而不是面向工程模块归档。

推荐展示策略：

- 有 headline，一句话说明本次版本主题。
- 展示 2 到 4 个分组，一级分组按变更类型组织，不按代码模块组织。
- 推荐分组：`功能变更`、`体验优化`、`问题修复`、`发布与更新`。
- 模块名可以出现在条目里作为上下文，但不要用 `核心架构`、`后端与服务端`、`IPC`
  这类工程模块做一级标题。
- 每个分组展示 1 到 3 条。
- 整张卡片默认控制在 6 到 10 条 changelist。
- 如果条目更多，只展示最重要的 8 条左右，并提示“更多内容见 Release / Changelog”。
- QA 重点单独展示 1 到 3 条。
- 风险提示只有非空时展示。

```text
本次版本聚焦桌面发布链路稳定性。

本次更新
- 发布与更新：稳定包下载入口只指向正式 release，避免 RC 包被外部用户下载。
- 问题修复：修复自动更新安装流程，减少 macOS 更新后未正确安装的情况。
- 体验优化：工作区设置里可以更清楚地选择稳定版或 RC 更新渠道。

QA 重点
- 验证 macOS 首次安装、从旧版本升级、以及外部下载入口。

更多内容见 Release 页面 / Changelog。
```

GitHub Release body 面向外部发布页，首期只展示英文摘要：

```text
## Release Summary
...
```

Release body 要用独立 marker 管理，避免和现有 Direct Downloads section 互相覆盖：

```text
<!-- tutti-desktop-release-summary:start -->
## Release Summary
...
<!-- tutti-desktop-release-summary:end -->

<!-- tutti-desktop-download-links:start -->
### Direct Downloads
...
<!-- tutti-desktop-download-links:end -->
```

重复运行时只替换各自 marker 之间的内容，不覆盖人工编辑内容，也不覆盖另一个 managed section。
GitHub generated release notes 可以保留在 summary 后面作为原始事实区，LLM summary 只作为顶部
人工可读摘要。

### diff 输入范围

summary 需要基于版本 diff 生成，而不是只读当前 commit。

推荐比较规则：

- stable release：
  - base 使用上一个 stable tag。
  - head 使用当前 stable tag / release target。
- patch release 从 RC 转 stable：
  - base 仍然使用上一个 stable tag。
  - head 使用本次 stable release target。
  - 可以额外标注 “来源 RC：v1.2.4-rc.1”。
- RC release：
  - 如果有上一个同 base 版本的 RC，则 base 使用上一个 RC。
  - 如果没有上一个 RC，则 base 使用上一个 stable tag。

输入可以包括：

- `git log --first-parent base..head`
- merge commit / PR title
- Conventional Commit 类型
- changed file summary
- GitHub Release generated notes
- 手写 override 文案

不要直接把完整 diff 交给 LLM。先用脚本压缩成结构化输入，避免 token 浪费和泄漏不必要细节。

LLM 输入需要降噪：

- 依赖锁文件、生成文件、格式化-only diff 默认降权或排除。
- 纯内部重构如果没有用户可感知影响，不应出现在飞书主摘要里。
- 安全、安装、自动更新、下载入口、数据迁移类变更需要提高优先级。
- 手写 override 可以补充产品措辞，但不能覆盖实际 diff 事实。

### LLM 接入方式

建议新增脚本：

```text
apps/desktop/scripts/generate-release-summary.mjs
```

职责：

1. 解析 release tag、channel、target commit。
2. 找到 compare base。
3. 收集 git log / PR title / changed file summary。
4. 组装一个固定 prompt。
5. 调用 LLM 生成双语结构化 JSON。
6. 校验 JSON schema。
7. 写出本次 workflow 内部使用的 `release-summary.json`，其中包含飞书展示内容、
   GitHub Release body 英文 markdown、以及 changelog entry。

Agnes 可以作为 LLM provider。根据 Agnes 文档，`agnes-2.0-flash` 使用
OpenAI-compatible Chat Completions API：

```text
POST https://apihub.agnes-ai.com/v1/chat/completions
model: agnes-2.0-flash
```

API key 必须放在 GitHub Secret，例如：

```text
AGNES_API_KEY
```

不要把真实 key 写进 workflow、脚本、文档或 release artifact。

如果没有配置 LLM key，release workflow 不应该失败。可以降级为：

- 使用 GitHub generated release notes。
- 或使用 commit / PR title 的规则化摘要。
- 飞书卡片显示 “本次更新摘要未生成，请查看 Release 页面”。

失败降级矩阵：

| 场景 | 处理方式 | 是否阻断 release |
| --- | --- | --- |
| 没有 LLM key | 使用 GitHub generated notes / commit title 生成简版 summary | 否 |
| LLM API 超时或失败 | 使用简版 summary，并在日志中记录原因 | 否 |
| LLM 返回非 JSON | 丢弃 LLM 输出，使用简版 summary | 否 |
| JSON schema 校验失败 | 丢弃 LLM 输出，使用简版 summary | 否 |
| 摘要为空或缺中文/英文 | 使用简版 summary 补齐缺失语言 | 否 |
| 摘要过长 | 按分组裁剪到飞书展示上限，完整内容放 Release body | 否 |
| 敏感信息检查失败 | 不发送该摘要，使用简版 summary，并标红 workflow | 是，直到确认不会泄漏 |
| GitHub Release body upsert 失败 | 不发布正式 release，避免 release body 和通知不一致 | 是 |
| stable `changelog.json` 写入失败 | 不发布正式 release，保持 draft，重跑 workflow 或 repair 流程修复 | 是 |
| 飞书发送失败 | release 不回滚，workflow 标红或告警 | 否 |

### 人工可读和可审阅

LLM 输出必须是“候选发布说明”，不能作为唯一事实来源。

建议约束：

- 只允许基于输入 commits / PR / diff summary 总结。
- 不允许编造未出现的功能。
- 不写“已彻底解决”“完全支持”这类过度承诺。
- 风险和 QA 重点可以为空，但不能编造高风险。
- 输出 JSON 必须通过 schema 校验。
- 飞书卡片默认展示 6 到 10 条 changelist；过长时裁剪，完整内容放 GitHub Release body
  和 `changelog.json`。

### 飞书卡片改造

现有 `apps/desktop/scripts/send-release-feishu-card.mjs` 可以新增
`--release-summary-file` 输入。

因为现有飞书通知是独立 `notify-feishu` job，如果 summary 在 `publish` job 生成，需要：

- 在 `publish` job 上传 `release-summary.json` 为 GitHub Actions artifact。
- 在 `notify-feishu` job 下载该 artifact。
- 或者把飞书发送移动到 publish job 的发布成功之后。

不要让 notify job 重新生成 summary，否则飞书、Release body、`changelog.json` 可能使用不同文案。

卡片展示顺序建议：

1. 发布完成标题。
2. 版本一句话说明。
3. 本次更新摘要。
4. QA 重点 / 风险提示。
5. 版本号、构建类型、commit、分支、部署人、完成时间。
6. 下载 / Release / 流水线按钮。

飞书通知使用中文即可。英文内容主要用于 GitHub Release body、长期 changelog 或面向外部
用户的发布页。GitHub Release body 首期只展示英文，避免外部 release 页面变得过长。

### 仓库内 Markdown changelog

首期可以先不维护仓库内 Markdown changelog。

原因：

- S3/CDN 上的 `changelog.json` 已经能支撑网页更新日志。
- `release-summary.json` 首期只是 workflow 内部 artifact，会被用于飞书、GitHub
  Release body 和 upsert `changelog.json`。
- GitHub Release body 会写入本版本英文摘要。
- 再维护 `docs/changelog/desktop.md` 会变成第二套同步成本。

因此首期不要新增：

```text
docs/changelog/desktop.md
```

如果后续需要在仓库里留一份人读的长期文档，再从 `changelog.json` 或
`release-summary.json` 生成 Markdown，并通过 bot PR 合入。

可选格式：

```markdown
# Desktop Changelog

## v1.2.4 - 2026-07-04

Channel: stable
Compare: v1.2.3...v1.2.4

### 中文

#### 功能优化

- 稳定包下载入口只指向正式 release，避免 RC 包被外部用户下载。

#### Bug Fix

- 修复自动更新安装流程，减少 macOS 更新后未正确安装的情况。

### English

#### Improvements

- Stable download links now point only to stable releases, preventing RC builds from reaching external users.

#### Bug Fixes

- Fixed the app update install flow to reduce failed macOS update installs.

### QA Notes

- 验证 macOS 首次安装、从旧版本升级、以及外部下载入口。
```

如果未来要加这个文件，也不建议由 release workflow 直接提交到 `main`。更稳的方式是：

- release workflow 生成本次 changelog entry；
- 这个 changelog entry 存在 workflow 生成的 `release-summary.json` 里；
- 如果是 stable release，创建或更新一个 bot PR；
- 由人 review 后合入；
- GitHub Release body 和飞书卡片先使用 artifact 内容。

RC 是否写入长期 changelog：

- RC 可以写入 release artifact 和 GitHub pre-release body。
- 长期 `docs/changelog/desktop.md` 默认只沉淀 stable。
- 如果 QA 需要追踪 RC，也可以在 changelog 里增加 `Pre-release` 小节，但不建议和
  stable 混在同一层级。

### workflow 放置位置

建议在 publish job 里按这个顺序执行：

1. 创建 GitHub draft release，并上传不可变 assets。
2. 上传 release assets 到 S3 tag 目录。
3. 生成 release summary。
4. 把英文摘要 upsert 到 GitHub Release body 的 summary marker。
5. upsert Direct Downloads marker。
6. 如果是 stable release，upsert `/changelog.json`。
7. 发布 GitHub Release。
8. 飞书通知在 release 发布成功后读取同一份 `release-summary.json`，展示中文摘要。

这样飞书卡片、GitHub Release、后续 changelog 都来自同一份结构化 summary，避免三处文案不一致。

## 实施拆分

### Step 1：保护公共 latest

- 给 S3 根目录 `latest.json` 生成和上传步骤增加 stable-only 条件。
- 给 `latest.json` 补 `channel`、`prerelease`、`releasedAt`、`gitSha`、
  `preferredDownloads` 等 stable 判定字段。
- 增加 workflow 测试。
- 更新桌面发布约定文档。

### Step 2：调整自动更新默认策略

- 默认 update channel 改成按包版本推导：正式包 `stable`，RC 包 `rc`，beta 包暂时 `stable`。
- 保留 `rc` 作为内部 opt-in。
- 在开发者设置中增加 stable / pre-release 控件。
- 明确既有用户 update channel 迁移规则。
- 明确 RC 自动更新仍走 GitHub pre-release / electron-updater `rc` channel。
- 增加偏好和 updater 配置测试。
- 更新桌面发布约定文档。

### Step 3：补充 RC 转正式 release 的操作文档

- 在 `docs/conventions/desktop-release.md` 增加 “从 RC commit 发布稳定版” 小节。
- 写清楚：
  - 常规用 `patch_release + target_commitish`。
  - 精确版本用 `explicit_version_release + version + target_commitish`。
  - 不要把 RC tag 直接当正式 release。
  - 校验 source RC tag 和 stable tag 指向同一个 commit。

### Step 4：加固 Cloudflare download worker

- 直接在 Cloudflare Dashboard 的 production editor 里更新
  `tutti-desktop-download` worker；当前 worker 源码不放在这个仓库里维护。
- worker 读取公共 `latest.json` 后校验它必须是 stable。
- 没有 query 时默认返回 stable 包。
- 支持 `channel=stable|preview|beta`：
  - `stable` 读取根目录 `latest.json`。
  - `preview` 读取 `channels/preview/latest.json`，并校验 metadata 必须是 RC。
  - `beta` 读取 `channels/beta/latest.json`，并校验 metadata 必须是 beta。
- `preview` 不 fallback 到 beta；beta 也不影响 preview。

### Step 5：增加发布摘要和 changelog

- 新增 `apps/desktop/scripts/generate-release-summary.mjs`。
- 生成双语 release summary artifact。
- 飞书卡片读取 summary 并展示中文摘要。
- GitHub Release body 写入英文摘要。
- stable release 更新 S3/CDN 上的 `changelog.json`，供网页 changelog 读取。
- `changelog.json` upsert 要支持并发串行、schema 校验、初始创建、幂等重跑和失败修复。
- `release-summary.json` 要在 publish 和 notify job 之间通过 artifact 传递，避免重复生成。
- Release body 使用独立 marker 管理 summary 和 direct downloads。
- 首期不新增 `docs/changelog/desktop.md`；如后续需要，再从 summary/changelog
  artifact 生成并通过 PR 维护。
- LLM key 使用 GitHub Secret，不写入仓库。

## 验证

代码侧建议跑：

```bash
node --test tools/scripts/desktop-release-config.test.mjs
node --import apps/desktop/test/register-asset-stub.mjs --test --experimental-strip-types apps/desktop/src/main/update/appUpdateService.test.ts apps/desktop/src/main/update/prefixedDesktopReleaseResolver.test.ts
pnpm check:changed --tail-lines 80
```

LLM 发布摘要建议增加：

```bash
node --test tools/scripts/desktop-release-summary.test.mjs
node --test tools/scripts/desktop-release-feishu-card.test.mjs
node --test tools/scripts/desktop-release-changelog.test.mjs
```

发布侧需要验证：

- 触发 RC workflow：
  - GitHub Release 是 pre-release。
  - GitHub Latest 仍然指向之前的 stable。
  - S3 tag 目录有 RC assets。
  - S3 根目录 `latest.json` 没有变化。
  - 飞书卡片展示中文 RC 摘要。
  - GitHub pre-release body 展示英文摘要。
  - 公开 `changelog.json` 不新增 RC 记录。
- 触发 stable workflow：
  - GitHub Release 不是 pre-release。
  - GitHub Latest 指向新的 stable tag。
  - S3 根目录 `latest.json` 指向新的 stable tag。
  - Cloudflare 外部下载地址拿到 stable universal macOS DMG。
  - 生成 stable changelog entry artifact。
  - S3/CDN `changelog.json` 新增或更新当前 stable 版本记录。
  - 重跑同一个 stable release 不产生重复 changelog 记录。
  - 飞书卡片、GitHub Release body、`changelog.json` 使用同一份 summary 内容。

## 待确认问题

- 后续是否要把 `tutti-desktop-download` worker 迁移进仓库版本管理；当前先按
  Cloudflare dashboard 维护。
- RC assets 是否需要继续上传到 S3 tag 目录，还是只保留 GitHub Release 下载？
- QA 是否需要通过自动更新持续收到后续 RC 包，还是固定 RC 下载链接就够？
- 是否需要增加 “stable draft release” 模式，让 QA 在对外 latest 更新前验证最终正式
  安装包？
- 长期 changelog 是否只记录 stable，还是也记录 RC？
- GitHub Release body 是否长期只保留英文，还是后续支持中英切换？
- release summary 是否允许自动创建 changelog PR？
