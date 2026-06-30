# App Center Developer Source Display Plan

## Goal

应用中心卡片支持展示应用来源，但默认不增加信息噪音：

- 默认关闭，由「设置 -> 开发者」里的开关控制。
- 打开后，应用卡片底部展示开发者来源行。
- 社区应用展示 GitHub 来源；官方应用展示 Tutti 官方标识。
- 多开发者不区分维护者/贡献者等级，只平铺展示。

## Interaction

### Card row

默认态：

```text
[avatar][avatar][avatar] 3 位开发者          GitHub icon
```

Hover 到开发者行：

```text
[avatar][avatar][avatar] 3 位开发者          >
```

点击开发者行打开浮窗。

### Popover

```text
开发者与来源

开发者
[avatar] 2042217959       external link
[avatar] Alice            external link
[avatar] Ben              external link

源码
competitive-product-analysis GitHub icon
design-review                GitHub icon
```

不展示 raw.githubusercontent.com，不展示长 URL，不展示维护者/贡献者等级。

## Main Repo MR: tutti

Branch/worktree:

```text
codex/app-center-developer-source
/Users/wwcome/work/tutti-os/.worktrees/app-center-developer-source
```

Scope:

1. Manifest contract
   - Keep existing `author?: { name; url? }` compatible.
   - Add optional `authors?: AppAuthor[]` for the card display.
   - Do not add `developers`; `author` + `developers` is too ambiguous.
   - Add optional `source?: { type: "github"; url: string }`.
   - Use `authors` first, then legacy `author` as fallback.
   - New manifests should not set both `author` and `authors`.

2. Manifest validation
   - Validate author `name`, optional `url`, optional `avatarUrl`.
   - Validate source GitHub URL as non-empty URL string.
   - Preserve old manifests.

3. App Center view model
   - Add developer/source metadata to `WorkspaceAppCardViewModel`.
   - Resolve display:
     - official: `Tutti 官方` + official badge.
     - one developer: avatar + name.
     - 2-3 developers: avatar group + `N 位开发者`.
     - 4+ developers: first 3 avatars + `N 位开发者`.

4. App Card UI
   - Add bottom developer/source row.
   - Default right icon: GitHub icon.
   - Row hover right icon: chevron.
   - Click row opens popover.
   - Stop propagation so clicking row does not open/install app.

5. Settings
   - Add Developer settings switch.
   - Default: off.
   - Suggested key: `showAppDeveloperSources`.
   - Store in Desktop Preferences, not local component state.

6. i18n
   - EN/ZH keys for switch, row labels, popover labels.

Checks:

```text
pnpm --filter @tutti-os/workspace-app-center test
pnpm --filter @tutti-os/desktop test -- WorkspaceSettingsPanel
pnpm --filter @tutti-os/desktop test -- desktopPreferences
```

## App Repo MR: competitive-product-analysis

Branch/worktree:

```text
codex/app-source-metadata
/Users/wwcome/work/tutti-os/.worktrees/competitive-product-analysis-source
```

Manifest update:

```json
{
  "authors": [
    {
      "name": "2042217959",
      "url": "https://github.com/2042217959",
      "avatarUrl": "https://github.com/2042217959.png"
    }
  ],
  "source": {
    "type": "github",
    "url": "https://github.com/tutti-os/competitive-product-analysis"
  }
}
```

Description:

```text
对比竞品定位、功能和体验，辅助产品决策。
```

Checks:

```text
project manifest validation
existing app test/build command
```

## App Repo MR: design-review

Branch/worktree:

```text
codex/app-source-metadata
/Users/wwcome/work/tutti-os/.worktrees/design-review-source
```

Manifest update:

```json
{
  "authors": [
    {
      "name": "2042217959",
      "url": "https://github.com/2042217959",
      "avatarUrl": "https://github.com/2042217959.png"
    }
  ],
  "source": {
    "type": "github",
    "url": "https://github.com/tutti-os/design-review"
  }
}
```

Description:

```text
检查流程、界面和体验问题，辅助发现设计风险。
```

Checks:

```text
project manifest validation
existing app test/build command
```

## Rollout Order

1. Merge main repo support first.
2. Update the two app manifests after the main repo accepts the new optional fields.
3. Keep the setting default off until the UI has enough real metadata.

## Skipped

- No role labels: no maintainer/contributor split.
- No full developer profile page.
- No card-level long URL display.
- No schema version bump unless validation tooling requires it.
