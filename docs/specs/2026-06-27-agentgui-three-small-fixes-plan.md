# AgentGUI 三个小改 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地三个独立的 AgentGUI 小改——消息中心标题显示最新用户任务、对话流图片右键复制、usage popover 内压缩按钮。

**Architecture:** 三个特性互不依赖，可任意顺序/分别成 PR。A 是纯 model 改动；B 新增一个 `radix-ui` ContextMenu 包装原语 + 一个 renderer 剪贴板工具，套到两个会话图片渲染点；C 给现有 `AgentUsageChip` 加一个复用 `/compact` 立即提交路径的按钮。

**Tech Stack:** TypeScript, React, vitest (`vitest run --environment jsdom`), `radix-ui` umbrella package, Tailwind。

## Global Constraints

- 前置：此 worktree 无 `node_modules`（bare repo + 外置 worktree）。动手前在仓库根跑 `pnpm install`。
- 右键菜单**不新增依赖**：`ContextMenu` 来自已安装的 `radix-ui` umbrella 包（`packages/ui/system`，`radix-ui: ^1.4.2`），与 `DropdownMenu`/`Popover` 同源。
- 图片复制**不新增 host API**：桌面 host clipboard 即 `navigator.clipboard`（`createDesktopAgentHostApi.ts:119`），直接走 renderer `navigator.clipboard.write([new ClipboardItem(...)])`。
- 新增文案加到 `packages/agent/gui/app/renderer/i18n/locales/en.ts` 和 `zh-CN.ts`，放在现有 `agentHost.agentGui` 命名空间内（紧邻 `copyMessage`）。
- 测试命令：`pnpm --filter @tutti-os/agent-gui test`；改动数据流的 Feature A 另跑 `pnpm check:agent-activity-runtime-boundaries`。
- 收尾按 `packages/agent/gui/AGENTS.md` 走 doc-impact 自评，多半更新 `docs/architecture/agent-gui-node.md`。

---

## File Structure

**Feature A — 消息中心标题**

- Modify: `packages/agent/gui/agent-message-center/workspaceAgentMessageCenterModel.ts`
- Test: `packages/agent/gui/agent-message-center/workspaceAgentMessageCenterModel.spec.ts`

**Feature B — 图片右键复制**

- Create: `packages/ui/system/src/components/context-menu/context-menu.tsx`
- Modify: `packages/ui/system/src/components/index.ts`
- Create: `packages/agent/gui/app/renderer/components/ui/context-menu.tsx` (re-export)
- Create: `packages/agent/gui/shared/agentConversation/lib/copyImageToClipboard.ts`
- Test: `packages/agent/gui/shared/agentConversation/lib/copyImageToClipboard.spec.ts`
- Modify: `packages/agent/gui/shared/agentConversation/components/AgentMessageBlock.tsx` (user image grid, line ~312-360)
- Modify: `packages/agent/gui/shared/agentConversation/components/tool-renderers/AgentImageGenerationContent.tsx` (agent image, line ~118)
- Modify: `packages/agent/gui/app/renderer/i18n/locales/{en,zh-CN}.ts`

**Feature C — 压缩按钮**

- Modify: `packages/agent/gui/agent-gui/agentGuiNode/AgentComposer.tsx` (`AgentUsageChip` line ~449-551, render site ~2733)
- Modify: `packages/agent/gui/app/renderer/i18n/locales/{en,zh-CN}.ts`

---

## Feature A — 消息中心标题 → 最新用户任务优先

### Task A1: latestUserMessageSummary + 标题优先级

**Files:**

- Modify: `packages/agent/gui/agent-message-center/workspaceAgentMessageCenterModel.ts:266-275` (resolveSessionTitle), `:281-371` (analysis), `:114-117` (call site)
- Test: `packages/agent/gui/agent-message-center/workspaceAgentMessageCenterModel.spec.ts`

**Interfaces:**

- Produces: `MessageCenterSessionMessageAnalysis.latestUserMessageSummary: string`
- Produces: `resolveSessionTitle(session, latestUserMessageSummary, firstUserMessageSummary): string`

- [ ] **Step 1: 写失败测试**（追加到 spec，复用文件内现有 `snapshot`/`message`/`session` 工厂）

```ts
it("uses the latest user message as the message-center title", () => {
  const model = buildWorkspaceAgentMessageCenterModel(
    snapshot({
      messages: [
        message({
          agentSessionId: "session-1",
          messageId: "user-1",
          role: "user",
          payload: { text: "First task" },
          occurredAtUnixMs: 10
        }),
        message({
          agentSessionId: "session-1",
          messageId: "user-2",
          role: "user",
          payload: { text: "Latest task" },
          occurredAtUnixMs: 30
        })
      ],
      sessions: [
        session({
          agentSessionId: "session-1",
          provider: "codex",
          status: "completed",
          title: "AI generated summary"
        })
      ]
    })
  );
  expect(model.items[0]?.title).toBe("Latest task");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @tutti-os/agent-gui test workspaceAgentMessageCenterModel`
Expected: FAIL — 实际为 `"AI generated summary"`（当前 session.title 优先）。

- [ ] **Step 3: 抓取最新用户消息**

在 `analyzeMessageCenterSessionMessages`（line ~303 起的声明区）加变量，并在遍历 user 分支里更新。

声明区（紧邻 `let firstUserMessageSummary = "";`）：

```ts
let latestUserMessageSummary = "";
```

遍历内 user 分支（替换 line 312-314 的 if 块）：

```ts
if (isUserMessageRole(message.role)) {
  const summary = messageSummary(message);
  if (!firstUserMessageSummary && summary) {
    firstUserMessageSummary = summary;
  }
  if (summary) {
    latestUserMessageSummary = summary;
  }
}
```

返回对象（line ~364）加字段：

```ts
return {
  firstUserMessageSummary,
  latestUserMessageSummary,
  latestDigestAgentMessage,
  latestAgentMessage,
  latestTurnOutcome: latestOutcome?.outcome ?? null,
  pendingPrompt: latestPendingPrompt?.prompt ?? null
};
```

在 interface `MessageCenterSessionMessageAnalysis`（line ~281）加：

```ts
latestUserMessageSummary: string;
```

- [ ] **Step 4: 改标题优先级**

替换 `resolveSessionTitle`（line 266-275）：

```ts
function resolveSessionTitle(
  session: AgentActivitySession,
  latestUserMessageSummary: string,
  firstUserMessageSummary: string
): string {
  const latest = latestUserMessageSummary.trim();
  if (latest) {
    return latest;
  }
  const title = session.title.trim();
  if (title) {
    return title;
  }
  return firstUserMessageSummary || session.provider || session.agentSessionId;
}
```

更新调用点（line 114-117）：

```ts
const title = resolveSessionTitle(
  session,
  messageAnalysis.latestUserMessageSummary,
  messageAnalysis.firstUserMessageSummary
);
```

- [ ] **Step 5: 跑新测试确认通过**

Run: `pnpm --filter @tutti-os/agent-gui test workspaceAgentMessageCenterModel`
Expected: 新 test PASS。

- [ ] **Step 6: 修正受影响的旧断言**

整套跑 `pnpm --filter @tutti-os/agent-gui test workspaceAgentMessageCenterModel`。新优先级下，「有用户消息时 session.title 优先」的旧断言会失败——这是预期的行为变更。逐个把它们的期望值改成「最新用户消息」。
注意：line 760（单条用户消息 `"User-only prompt"`）与 line 709（无用户消息回退 session.title）应**仍然通过**，不要改。
Expected: 全绿。

- [ ] **Step 7: 数据流边界检查**

Run: `pnpm check:agent-activity-runtime-boundaries`
Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add packages/agent/gui/agent-message-center/workspaceAgentMessageCenterModel.ts \
        packages/agent/gui/agent-message-center/workspaceAgentMessageCenterModel.spec.ts
git commit -m "feat(agent-gui): show latest user task as message-center title"
```

---

## Feature B — 对话流图片右键复制

### Task B1: ContextMenu 原语（复用 radix-ui umbrella）

**Files:**

- Create: `packages/ui/system/src/components/context-menu/context-menu.tsx`
- Modify: `packages/ui/system/src/components/index.ts:10` 区域
- Create: `packages/agent/gui/app/renderer/components/ui/context-menu.tsx`

**Interfaces:**

- Produces: `ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem`（从 `@tutti-os/ui-system` 导出）

- [ ] **Step 1: 写失败测试**

Create `packages/ui/system/src/components/context-menu/context-menu.spec.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from "./context-menu";

describe("ContextMenu", () => {
  it("renders a trigger target", () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>
          <span data-testid="target">target</span>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Copy image</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
    expect(screen.getByTestId("target")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @tutti-os/ui-system test context-menu`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现原语（镜像 dropdown-menu.tsx）**

Create `packages/ui/system/src/components/context-menu/context-menu.tsx`:

```tsx
import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";

import { cn } from "#lib/utils";
import { MenuSurface, menuItemClassName } from "../menu-surface";

function ContextMenu({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return (
    <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
  );
}

function ContextMenuContent({
  className,
  children,
  style,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        asChild
        data-slot="context-menu-content"
        {...props}
      >
        <MenuSurface
          data-slot="context-menu-content"
          className={cn(
            "z-50 min-w-32 overflow-x-hidden overflow-y-auto",
            className
          )}
          style={{ zIndex: "var(--z-popover)", ...style }}
        >
          {children}
        </MenuSurface>
      </ContextMenuPrimitive.Content>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <ContextMenuPrimitive.Item
      data-inset={inset}
      data-slot="context-menu-item"
      data-variant={variant}
      className={cn(
        "group/context-menu-item",
        menuItemClassName,
        "data-inset:pl-7",
        className
      )}
      {...props}
    />
  );
}

export { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger };
```

- [ ] **Step 4: 从 ui/system barrel 导出**

在 `packages/ui/system/src/components/index.ts` 第 10 行 `export * from "./dropdown-menu";` 后加一行：

```ts
export * from "./context-menu/context-menu";
```

（注意：dropdown-menu 的导出路径是目录简写 `./dropdown-menu`，因其有 `index`；context-menu 直写文件路径即可。若该目录也加了 `index.ts` 则用 `./context-menu`。）

- [ ] **Step 5: agent/gui 侧 re-export（镜像 ui/dropdown-menu.tsx）**

Create `packages/agent/gui/app/renderer/components/ui/context-menu.tsx`:

```tsx
export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from "@tutti-os/ui-system";
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @tutti-os/ui-system test context-menu`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add packages/ui/system/src/components/context-menu/ \
        packages/ui/system/src/components/index.ts \
        packages/agent/gui/app/renderer/components/ui/context-menu.tsx
git commit -m "feat(ui-system): add ContextMenu primitive from radix-ui umbrella"
```

### Task B2: copyImageToClipboard 工具

**Files:**

- Create: `packages/agent/gui/shared/agentConversation/lib/copyImageToClipboard.ts`
- Test: `packages/agent/gui/shared/agentConversation/lib/copyImageToClipboard.spec.ts`

**Interfaces:**

- Produces: `copyImageToClipboard(src: string): Promise<boolean>`

- [ ] **Step 1: 写失败测试**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { copyImageToClipboard } from "./copyImageToClipboard";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("copyImageToClipboard", () => {
  it("returns false when navigator.clipboard.write is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    expect(await copyImageToClipboard("data:image/png;base64,xxx")).toBe(false);
  });

  it("writes a png blob straight through", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const pngBlob = new Blob(["png"], { type: "image/png" });
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        items: Record<string, Blob>;
        constructor(items: Record<string, Blob>) {
          this.items = items;
        }
      }
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ blob: () => Promise.resolve(pngBlob) })
    );

    expect(await copyImageToClipboard("blob:abc")).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("returns false when clipboard write throws", async () => {
    const write = vi.fn().mockRejectedValue(new Error("denied"));
    const pngBlob = new Blob(["png"], { type: "image/png" });
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(_: unknown) {}
      }
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ blob: () => Promise.resolve(pngBlob) })
    );
    expect(await copyImageToClipboard("blob:abc")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @tutti-os/agent-gui test copyImageToClipboard`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
// ClipboardItem reliably supports only image/png, so non-png sources are
// rasterised to png via an offscreen canvas before writing.
async function imageSrcToPngBlob(src: string): Promise<Blob | null> {
  const response = await fetch(src);
  const blob = await response.blob();
  if (blob.type === "image/png") {
    return blob;
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.drawImage(bitmap, 0, 0);
  return await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((result) => resolve(result), "image/png")
  );
}

export async function copyImageToClipboard(src: string): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.clipboard?.write !== "function" ||
    typeof ClipboardItem === "undefined"
  ) {
    return false;
  }
  try {
    const blob = await imageSrcToPngBlob(src);
    if (!blob) {
      return false;
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}
```

注：非 png 的 canvas 转换路径依赖 `createImageBitmap`/`canvas.toBlob`，jsdom 不实现，故只在单测覆盖 png 直传与失败回退；非 png 路径靠手动验证（见 Task B3 收尾）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @tutti-os/agent-gui test copyImageToClipboard`
Expected: 3 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/agent/gui/shared/agentConversation/lib/copyImageToClipboard.ts \
        packages/agent/gui/shared/agentConversation/lib/copyImageToClipboard.spec.ts
git commit -m "feat(agent-gui): add copyImageToClipboard helper"
```

### Task B3: 套到两个会话图片渲染点 + i18n

**Files:**

- Modify: `packages/agent/gui/app/renderer/i18n/locales/en.ts:540` 区域、`zh-CN.ts:496` 区域
- Modify: `packages/agent/gui/shared/agentConversation/components/AgentMessageBlock.tsx:312-360`
- Modify: `packages/agent/gui/shared/agentConversation/components/tool-renderers/AgentImageGenerationContent.tsx:117-120`

**Interfaces:**

- Consumes: `copyImageToClipboard` (B2), `ContextMenu*` (B1)

- [ ] **Step 1: 加 i18n key**

`en.ts`（`agentHost.agentGui` 内，紧邻 `copyMessage: "Copy message",`）：

```ts
      copyImage: "Copy image",
      imageCopied: "Image copied",
      copyImageFailed: "Couldn't copy image",
```

`zh-CN.ts`（紧邻 `copyMessage: "复制消息",`）：

```ts
      copyImage: "复制图片",
      imageCopied: "已复制图片",
      copyImageFailed: "复制图片失败",
```

- [ ] **Step 2: 写一个共享包装组件（在 AgentMessageBlock.tsx 内）**

在 `AgentMessageBlock.tsx` 顶部加 import：

```tsx
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from "../../../app/renderer/components/ui/context-menu";
import { copyImageToClipboard } from "../lib/copyImageToClipboard";
```

在 `AgentUserImageGrid` 上方加包装组件：

```tsx
function ConversationImageContextMenu({
  src,
  children
}: {
  src: string;
  children: React.ReactNode;
}): JSX.Element {
  const handleCopy = useCallback(() => {
    void copyImageToClipboard(src);
  }, [src]);
  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={handleCopy}>
          {translate("agentHost.agentGui.copyImage")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
```

（toast：若该模块已有 toast 通道则 `.then(ok => toast(ok ? imageCopied : copyImageFailed))`；若无，保留静默复制——与现有 `copyImageToClipboard` 布尔返回一致，不阻塞。导出 hook：实现者按文件内现有 toast 用法决定，无则省略。）

- [ ] **Step 3: 包住用户图片**（AgentUserImageGrid，line 338-344 的 ZoomableImage）

```tsx
            {src ? (
              <ConversationImageContextMenu src={src}>
                <ZoomableImage
                  src={src}
                  alt={image.name?.trim() || "image"}
                  className="block max-h-20 w-full rounded-[6px] object-contain"
                  draggable={false}
                />
              </ConversationImageContextMenu>
            ) : loading ? (
```

- [ ] **Step 4: 包住 agent 生成图片**（AgentImageGenerationContent.tsx，line 118-125 的 ZoomableImage）

先在该文件 import 包装组件（从 `../AgentMessageBlock` 导出 `ConversationImageContextMenu`，或抽到 `../lib`；推荐抽到独立文件 `packages/agent/gui/shared/agentConversation/components/ConversationImageContextMenu.tsx` 再两处 import，避免循环依赖）。
将 `<ZoomableImage .../>` 用 `<ConversationImageContextMenu src={src}>...</ConversationImageContextMenu>` 包住。

> 决策：把 Step 2 的 `ConversationImageContextMenu` 直接建为独立文件
> `components/ConversationImageContextMenu.tsx`，两处 import。避免 AgentImageGenerationContent → AgentMessageBlock 反向依赖。

- [ ] **Step 5: 跑包测试**

Run: `pnpm --filter @tutti-os/agent-gui test`
Expected: PASS（无回归）。

- [ ] **Step 6: 手动验证 type-check**

Run: `pnpm --filter @tutti-os/agent-gui exec tsc --noEmit`（或仓库约定的 typecheck）
Expected: 无类型错误。

- [ ] **Step 7: Commit**

```bash
git add packages/agent/gui/shared/agentConversation/ \
        packages/agent/gui/app/renderer/i18n/locales/en.ts \
        packages/agent/gui/app/renderer/i18n/locales/zh-CN.ts
git commit -m "feat(agent-gui): right-click copy on conversation images"
```

---

## Feature C — usage popover 内压缩按钮

### Task C1: AgentUsageChip 加压缩按钮

**Files:**

- Modify: `packages/agent/gui/agent-gui/agentGuiNode/AgentComposer.tsx`（`AgentUsageChip` line 449-551，render site line 2733-2748）
- Modify: `packages/agent/gui/app/renderer/i18n/locales/{en,zh-CN}.ts`

**Interfaces:**

- Consumes: 已存在的 `onSubmit`、`textPromptContent`、`compactSupported`、`hasCompactableContext` 与 busy/disabled 状态。

- [ ] **Step 1: 加 i18n key**

`en.ts`（`agentHost.agentGui` 内）：

```ts
      compactContext: "Compact context",
```

`zh-CN.ts`：

```ts
      compactContext: "压缩上下文",
```

- [ ] **Step 2: 写失败测试**

在 AgentComposer 的现有测试套件（`AgentGUINode.spec.tsx` 或 composer 专属 spec，沿用其渲染工具）追加：当 `compactSupported && hasCompactableContext && !busy` 时，usage popover 内渲染 `data-testid="agent-gui-compact-button"`；点击后调用 `onSubmit`，参数为 `/compact` 文本 prompt。不支持/ busy 时不渲染该 button。
断言要点：

```ts
expect(screen.queryByTestId("agent-gui-compact-button")).toBeInTheDocument();
// click
expect(onSubmit).toHaveBeenCalledWith(textPromptContent("/compact"));
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @tutti-os/agent-gui test AgentComposer`（或对应 spec 名）
Expected: FAIL — 无该 testid。

- [ ] **Step 4: 扩展 AgentUsageChip 的 props**

`AgentUsageChip` 参数（line 449-470）加：

```ts
  onCompact,
  compactEnabled
}: {
  percentUsed: number;
  usedTokens: number | null;
  totalTokens: number | null;
  limits: readonly AgentComposerSlashStatusLimit[];
  tooltipsEnabled?: boolean;
  onCompact?: () => void;
  compactEnabled?: boolean;
  labels: Pick<
    AgentComposerProps["labels"],
    | "usageChipLabel"
    | "usageTooltipLabel"
    | "usagePopoverTitle"
    | "usageContextWindowLabel"
    | "usageLimitsLabel"
    | "compactContextLabel"
  >;
}): React.JSX.Element {
```

- [ ] **Step 5: 在 PopoverContent 底部渲染按钮**

在 `</div>` 关闭 `flex min-w-0 flex-col gap-3` 之前（line ~546-547），加：

```tsx
{
  compactEnabled && onCompact ? (
    <button
      type="button"
      data-testid="agent-gui-compact-button"
      className="nodrag inline-flex items-center justify-center rounded-[6px] bg-[var(--transparency-block)] px-2 py-1 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-background-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [-webkit-app-region:no-drag]"
      onClick={onCompact}
    >
      {labels.compactContextLabel}
    </button>
  ) : null;
}
```

- [ ] **Step 6: 在 render site 透传**（line 2733-2748）

```tsx
{
  usage && usage.percentUsed !== null ? (
    <AgentUsageChip
      percentUsed={usage.percentUsed}
      usedTokens={usage.usedTokens}
      totalTokens={usage.totalTokens}
      limits={slashStatus?.limits ?? []}
      tooltipsEnabled={!previewMode}
      compactEnabled={
        (compactSupported ?? false) &&
        hasCompactableContext &&
        !settingsControlsDisabled
      }
      onCompact={() => onSubmit(textPromptContent("/compact"))}
      labels={{
        usageChipLabel: labels.usageChipLabel,
        usageTooltipLabel: labels.usageTooltipLabel,
        usagePopoverTitle: labels.usagePopoverTitle,
        usageContextWindowLabel: labels.usageContextWindowLabel,
        usageLimitsLabel: labels.usageLimitsLabel,
        compactContextLabel: labels.compactContextLabel
      }}
    />
  ) : null;
}
```

注：`compactSupported`、`hasCompactableContext`、`settingsControlsDisabled` 已在 AgentComposer 作用域内（props line 165-166/681-682）。`labels.compactContextLabel` 需在 AgentComposerProps 的 labels 类型定义里补声明，并在装配 labels 的上层（i18n → composer labels 映射处）接上 `agentHost.agentGui.compactContext`。

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --filter @tutti-os/agent-gui test AgentComposer`
Expected: PASS。

- [ ] **Step 8: 全包回归 + typecheck**

Run: `pnpm --filter @tutti-os/agent-gui test && pnpm --filter @tutti-os/agent-gui exec tsc --noEmit`
Expected: 全绿。

- [ ] **Step 9: Commit**

```bash
git add packages/agent/gui/agent-gui/agentGuiNode/AgentComposer.tsx \
        packages/agent/gui/app/renderer/i18n/locales/en.ts \
        packages/agent/gui/app/renderer/i18n/locales/zh-CN.ts
git commit -m "feat(agent-gui): add compact-context button to usage popover"
```

---

## 收尾（全部完成后）

- [ ] 跑 `pnpm --filter @tutti-os/agent-gui test`、`pnpm --filter @tutti-os/ui-system test`、`pnpm check:agent-activity-runtime-boundaries` 全绿。
- [ ] 按 `packages/agent/gui/AGENTS.md` 的 doc-impact 提示，对 `docs/architecture/agent-gui-node.md` 做 discard/improve/merge/create 决策；标题派生与 usage popover 交互变更通常需要 improve 既有条目。
- [ ] `pnpm check:changed` 给混合改动收尾。

## Self-Review 结论

- **Spec coverage:** 三特性各有任务覆盖（A=A1，B=B1/B2/B3，C=C1）；i18n、测试、doc-impact 均在任务内。
- **Placeholder scan:** 代码步骤均给完整代码；toast 通道与 labels 装配处依赖文件内既有约定，已注明定位方式而非留 TODO。
- **Type consistency:** `copyImageToClipboard`、`ConversationImageContextMenu`、`ContextMenu*` 命名在 B1/B2/B3 间一致；`compactEnabled`/`onCompact`/`compactContextLabel` 在 C1 内一致。

---

## Feature D — 持久化消息中心筛选选择（用户补充需求 2026-06-27）

记住 `WorkspaceAgentMessageCenterPanel` 的筛选选择（分组 `groupBy`、状态筛选 `statusFilters`、provider 筛选 `providerFilters`），跨 App 重启保留。机制：localStorage，镜像 `packages/workspace/file-manager/src/ui/workspaceFileManagerArrangeMode.ts` 的 `typeof window` 守卫 + read/write 先例。详见 task-D1-brief.md。
