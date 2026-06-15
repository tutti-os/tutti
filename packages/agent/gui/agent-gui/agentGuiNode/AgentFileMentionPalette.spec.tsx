import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentFileMentionPalette } from "./AgentFileMentionPalette";
import type { AgentMentionSearchState } from "./AgentMentionSearchController";

vi.mock("../../i18n/index", async () => {
  const actual =
    await vi.importActual<typeof import("../../i18n/index")>(
      "../../i18n/index"
    );
  const labels: Record<string, string> = {
    "agentHost.agentGui.mentionFilterAll": "All",
    "agentHost.agentGui.mentionFilterApp": "Apps",
    "agentHost.agentGui.mentionFilterFile": "Files",
    "agentHost.agentGui.mentionFilterSession": "Sessions",
    "agentHost.agentGui.mentionGroupApps": "Apps",
    "agentHost.agentGui.mentionGroupIssues": "事项",
    "agentHost.agentGui.mentionEmptyIssues": "暂无事项",
    "agentHost.agentGui.mentionFilterIssue": "事项",
    "agentHost.agentGui.fileMentionSwitchCategory": "切换分类",
    "agentHost.agentGui.fileMentionSwitchSelection": "切换选中",
    "agentHost.agentGui.contextPickerBrowseFileHint":
      "暂无已打开或 Agent 生成的文件，继续输入文件名可搜索本机文件",
    "agentHost.agentGui.mentionFileSearchMoreHint":
      "继续输入文件名可搜索更多本机文件",
    "agentHost.agentGui.mentionGroupOpenedFiles": "我打开的文件",
    "agentHost.agentGui.mentionGroupAgentGeneratedFiles": "Agent 生成的文件",
    "agentHost.agentGui.mentionAgentGeneratedFolderBack": "返回",
    "agentHost.agentGui.mentionNoMatchingFiles": "没有匹配到文件",
    "agentHost.roomIssueNode.issueStatusNotStarted": "未启动",
    "agentHost.roomIssueNode.issueStatusRunning": "执行中",
    "agentHost.roomIssueNode.issueStatusInProgress": "已推进",
    "agentHost.roomIssueNode.issueStatusPendingAcceptance": "待验收",
    "agentHost.roomIssueNode.issueStatusCompleted": "已完成",
    "agentHost.roomIssueNode.issueStatusFailed": "失败",
    "agentHost.roomIssueNode.issueStatusCanceled": "已取消",
    "agentHost.workspaceAgentActivityStatusWorking": "运行中",
    "agentHost.workspaceAgentActivityStatusWaiting": "等待中",
    "agentHost.workspaceAgentActivityStatusIdle": "已完成",
    "agentHost.workspaceAgentActivityStatusEnd": "已完成",
    "agentHost.workspaceAgentActivityStatusCompleted": "已完成",
    "agentHost.workspaceAgentActivityStatusCanceled": "已取消",
    "agentHost.workspaceAgentActivityStatusFailed": "错误"
  };

  return {
    ...actual,
    translate: (key: string, options?: { count?: number }) => {
      if (key === "agentHost.agentGui.contextPickerExpandMore") {
        return `展开更多 ${options?.count ?? 0} 条`;
      }
      return labels[key] ?? key;
    }
  };
});

describe("AgentFileMentionPalette", () => {
  it("renders issue mentions with room issue status labels instead of agent session labels", () => {
    const state: AgentMentionSearchState = {
      status: "ready",
      query: "",
      mode: "browse",
      filter: "issue",
      categories: [],
      groups: [
        {
          id: "issues",
          items: [
            {
              kind: "workspace-issue",
              href: "tsh://room/room-1/task/task-1",
              workspaceId: "room-1",
              targetId: "task-1",
              name: "写一个文件",
              title: "写一个文件",
              creatorName: "Alice",
              status: "not_started"
            },
            {
              kind: "workspace-issue",
              href: "tsh://room/room-1/task/task-2",
              workspaceId: "room-1",
              targetId: "task-2",
              name: "查询天气",
              title: "查询天气",
              creatorName: "Bob",
              status: "running"
            },
            {
              kind: "workspace-issue",
              href: "tsh://room/room-1/task/task-3",
              workspaceId: "room-1",
              targetId: "task-3",
              name: "继续推进",
              title: "继续推进",
              creatorName: "Cathy",
              status: "in_progress"
            },
            {
              kind: "workspace-issue",
              href: "tsh://room/room-1/task/task-4",
              workspaceId: "room-1",
              targetId: "task-4",
              name: "整理输出",
              title: "整理输出",
              creatorName: "Dora",
              status: "pending_acceptance"
            },
            {
              kind: "workspace-issue",
              href: "tsh://room/room-1/task/task-5",
              workspaceId: "room-1",
              targetId: "task-5",
              name: "归档结果",
              title: "归档结果",
              creatorName: "Eve",
              status: "completed"
            },
            {
              kind: "workspace-issue",
              href: "tsh://room/room-1/task/task-6",
              workspaceId: "room-1",
              targetId: "task-6",
              name: "重试任务",
              title: "重试任务",
              creatorName: "Frank",
              status: "failed"
            },
            {
              kind: "workspace-issue",
              href: "tsh://room/room-1/task/task-7",
              workspaceId: "room-1",
              targetId: "task-7",
              name: "停止执行",
              title: "停止执行",
              creatorName: "Grace",
              status: "canceled"
            }
          ],
          totalCount: 7,
          visibleCount: 7,
          hasMore: false
        }
      ],
      error: null
    };

    render(
      <AgentFileMentionPalette
        state={state}
        highlightedKey="issues:workspace-issue:task-1"
        label="mention palette"
        loadingLabel="loading"
        emptyLabel="empty"
        errorLabel="error"
        tabHintLabel="hint"
        maxHeightPx={320}
        onHighlightChange={vi.fn()}
        onSelectItem={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectFilter={vi.fn()}
        onExpandGroup={vi.fn()}
        onCycleFilter={vi.fn()}
        onMoveSelection={vi.fn()}
      />
    );

    expect(screen.getByText("未启动")).toBeVisible();
    expect(screen.getByText("执行中")).toBeVisible();
    expect(screen.getByText("已推进")).toBeVisible();
    expect(screen.getByText("待验收")).toBeVisible();
    expect(screen.getByText("已完成")).toBeVisible();
    expect(screen.getAllByText("失败")).toHaveLength(1);
    expect(screen.getByText("已取消")).toBeVisible();
    for (const statusTag of document.querySelectorAll(
      '[data-agent-mention-status-tag="true"]'
    )) {
      expect(statusTag.className).not.toContain("border-[");
    }
    expect(screen.queryByText("空闲")).toBeNull();
    expect(screen.queryByText("已退出")).toBeNull();
  });

  it("renders session mention status tags with activity-core display statuses", () => {
    const state: AgentMentionSearchState = {
      status: "ready",
      query: "",
      mode: "browse",
      filter: "session",
      categories: [],
      groups: [
        {
          id: "my_sessions",
          items: [
            {
              kind: "session",
              href: "tsh://room/room-1/session/session-1",
              workspaceId: "room-1",
              targetId: "session-1",
              name: "Alice & Codex 看看目录",
              title: "看看目录",
              scope: "my_sessions",
              initiatorName: "Alice",
              agentName: "Codex",
              status: "running"
            },
            {
              kind: "session",
              href: "tsh://room/room-1/session/session-2",
              workspaceId: "room-1",
              targetId: "session-2",
              name: "Alice & Codex 等待确认",
              title: "等待确认",
              scope: "my_sessions",
              initiatorName: "Alice",
              agentName: "Codex",
              status: "waiting"
            },
            {
              kind: "session",
              href: "tsh://room/room-1/session/session-3",
              workspaceId: "room-1",
              targetId: "session-3",
              name: "Alice & Codex 已完成当前轮次",
              title: "已完成当前轮次",
              scope: "my_sessions",
              initiatorName: "Alice",
              agentName: "Codex",
              status: "idle"
            },
            {
              kind: "session",
              href: "tsh://room/room-1/session/session-4",
              workspaceId: "room-1",
              targetId: "session-4",
              name: "Alice & Codex 结束会话",
              title: "结束会话",
              scope: "my_sessions",
              initiatorName: "Alice",
              agentName: "Codex",
              status: "completed"
            },
            {
              kind: "session",
              href: "tsh://room/room-1/session/session-5",
              workspaceId: "room-1",
              targetId: "session-5",
              name: "Alice & Codex 准备就绪",
              title: "准备就绪",
              scope: "my_sessions",
              initiatorName: "Alice",
              agentName: "Codex",
              status: "ready"
            },
            {
              kind: "session",
              href: "tsh://room/room-1/session/session-6",
              workspaceId: "room-1",
              targetId: "session-6",
              name: "Alice & Codex 已结束",
              title: "已结束",
              scope: "my_sessions",
              initiatorName: "Alice",
              agentName: "Codex",
              status: "end"
            },
            {
              kind: "session",
              href: "tsh://room/room-1/session/session-7",
              workspaceId: "room-1",
              targetId: "session-7",
              name: "Alice & Codex 已完成",
              title: "已完成",
              scope: "my_sessions",
              initiatorName: "Alice",
              agentName: "Codex",
              status: "done"
            },
            {
              kind: "session",
              href: "tsh://room/room-1/session/session-8",
              workspaceId: "room-1",
              targetId: "session-8",
              name: "Alice & Codex 未知状态",
              title: "未知状态",
              scope: "my_sessions",
              initiatorName: "Alice",
              agentName: "Codex",
              status: "unknown"
            },
            {
              kind: "session",
              href: "tsh://room/room-1/session/session-9",
              workspaceId: "room-1",
              targetId: "session-9",
              name: "Alice & Codex 执行失败",
              title: "执行失败",
              scope: "my_sessions",
              initiatorName: "Alice",
              agentName: "Codex",
              status: "failed"
            }
          ],
          totalCount: 9,
          visibleCount: 9,
          hasMore: false
        }
      ],
      error: null
    };

    render(
      <AgentFileMentionPalette
        state={state}
        highlightedKey="my_sessions:session:session-1"
        label="mention palette"
        loadingLabel="loading"
        emptyLabel="empty"
        errorLabel="error"
        tabHintLabel="hint"
        maxHeightPx={320}
        onHighlightChange={vi.fn()}
        onSelectItem={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectFilter={vi.fn()}
        onExpandGroup={vi.fn()}
        onCycleFilter={vi.fn()}
        onMoveSelection={vi.fn()}
      />
    );

    expect(screen.getByText("运行中")).toBeVisible();
    expect(screen.getByText("等待中")).toBeVisible();
    expect(screen.getAllByText("错误")).toHaveLength(1);
    const statusTags = Array.from(
      document.querySelectorAll('[data-agent-mention-status-tag="true"]')
    );
    expect(statusTags.map((tag) => tag.textContent)).toEqual([
      "运行中",
      "等待中",
      "已完成",
      "已完成",
      "已完成",
      "已完成",
      "已完成",
      "已完成",
      "错误"
    ]);
    expect(statusTags.map((tag) => tag.getAttribute("data-status"))).toEqual([
      "working",
      "waiting",
      "idle",
      "completed",
      "idle",
      "idle",
      "completed",
      "idle",
      "failed"
    ]);
    expect(statusTags.map((tag) => tag.getAttribute("data-tone"))).toEqual([
      "blue",
      "amber",
      "green",
      "green",
      "green",
      "green",
      "green",
      "green",
      "red"
    ]);
    expect(statusTags[0]).toHaveClass("bg-sky-500/10", "text-sky-700");
    expect(statusTags[1]).toHaveClass(
      "bg-[color:color-mix(in_srgb,var(--color-amber-500)_12%,transparent)]",
      "text-[var(--color-amber-500)]"
    );
    expect(statusTags[2]).toHaveClass(
      "bg-[var(--tsh-ui-pill-success-bg)]",
      "text-[var(--tsh-ui-pill-success-fg)]"
    );
    expect(statusTags[8]).toHaveClass(
      "bg-[var(--on-danger)]",
      "text-[var(--state-danger)]"
    );
    const selectedOption = screen.getByRole("option", { selected: true });
    expect(selectedOption).toHaveClass(
      "rounded-[6px]",
      "bg-[var(--transparency-block)]"
    );
    const sessionRow = selectedOption.querySelector(
      ".grid-cols-\\[minmax\\(0\\,1fr\\)_auto\\]"
    );
    expect(sessionRow).toHaveClass(
      "grid",
      "w-full",
      "min-w-0",
      "items-center",
      "gap-3"
    );
    expect(statusTags[0]).toHaveClass("shrink-0");
    const userAvatarImage = selectedOption.querySelector(
      '[data-agent-mention-user-avatar="true"] img'
    );
    const avatarStack = selectedOption.querySelector(
      '[data-agent-mention-user-avatar="true"]'
    )?.parentElement;
    const userAvatar = selectedOption.querySelector(
      '[data-agent-mention-user-avatar="true"]'
    );
    const agentAvatar = selectedOption.querySelector(
      '[data-agent-mention-agent-avatar="true"]'
    );
    expect(avatarStack).toHaveClass("h-5", "w-9");
    expect(userAvatar).toHaveClass("h-5", "w-5");
    expect(agentAvatar).toHaveClass("left-4", "h-5", "w-5");
    expect(userAvatarImage).toHaveAttribute(
      "src",
      expect.stringContaining("user-avatar-placeholder")
    );
    expect(userAvatarImage).toHaveClass(
      "workspace-agents-status-panel__avatar-img--user-placeholder"
    );
  });

  it("uses the session provider to resolve agent mention avatars", () => {
    const state: AgentMentionSearchState = {
      status: "ready",
      query: "",
      mode: "browse",
      filter: "session",
      categories: [],
      groups: [
        {
          id: "my_sessions",
          items: [
            {
              kind: "session",
              href: "mention://agent-session?workspaceId=room-1&id=session-1&provider=codex",
              workspaceId: "room-1",
              targetId: "session-1",
              name: "Alice & Custom Agent 看看目录",
              title: "看看目录",
              scope: "my_sessions",
              initiatorName: "Alice",
              agentName: "Custom Agent",
              status: "working"
            }
          ],
          totalCount: 1,
          visibleCount: 1,
          hasMore: false
        }
      ],
      error: null
    };

    render(
      <AgentFileMentionPalette
        state={state}
        highlightedKey="my_sessions:session:session-1"
        label="mention palette"
        loadingLabel="loading"
        emptyLabel="empty"
        errorLabel="error"
        tabHintLabel="hint"
        maxHeightPx={320}
        onHighlightChange={vi.fn()}
        onSelectItem={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectFilter={vi.fn()}
        onExpandGroup={vi.fn()}
        onCycleFilter={vi.fn()}
        onMoveSelection={vi.fn()}
      />
    );

    const agentAvatarImage = document.querySelector(
      '[data-agent-mention-agent-avatar="true"] img'
    );
    expect(agentAvatarImage).toHaveAttribute(
      "src",
      expect.stringContaining("codex-rounded")
    );
  });

  it("keeps long issue titles truncated inside the palette row", () => {
    const longTitle =
      "很久很久以前，在一个遥远的王国里，住着一位美丽善良的公主。她的皮肤像雪一样白皙，嘴唇像鲜血一样红润。";
    const state: AgentMentionSearchState = {
      status: "ready",
      query: "公主",
      mode: "results",
      filter: "all",
      categories: [],
      groups: [
        {
          id: "issues",
          items: [
            {
              kind: "workspace-issue",
              href: "tsh://room/room-1/task/task-1",
              workspaceId: "room-1",
              targetId: "task-1",
              name: longTitle,
              title: longTitle,
              creatorName: "Alice",
              status: "idle"
            }
          ],
          totalCount: 1,
          visibleCount: 1,
          hasMore: false
        }
      ],
      error: null
    };

    render(
      <AgentFileMentionPalette
        state={state}
        highlightedKey="issues:workspace-issue:task-1"
        label="mention palette"
        loadingLabel="loading"
        emptyLabel="empty"
        errorLabel="error"
        tabHintLabel="hint"
        maxHeightPx={320}
        onHighlightChange={vi.fn()}
        onSelectItem={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectFilter={vi.fn()}
        onExpandGroup={vi.fn()}
        onCycleFilter={vi.fn()}
        onMoveSelection={vi.fn()}
      />
    );

    const option = screen.getByRole("option", { selected: true });
    const title = within(option).getByText(longTitle);
    const statusTag = option.querySelector(
      '[data-agent-mention-status-tag="true"]'
    );

    expect(option).toHaveClass("min-w-0", "overflow-hidden");
    expect(title).toHaveClass(
      "min-w-0",
      "truncate",
      "text-[13px]",
      "text-[var(--text-primary)]"
    );
    expect(title.parentElement).toHaveClass(
      "min-w-0",
      "items-center",
      "gap-2",
      "overflow-hidden"
    );
    expect(title.parentElement?.parentElement).toHaveClass(
      "min-w-0",
      "overflow-hidden"
    );
    expect(statusTag).toHaveAttribute("data-slot", "badge");
    expect(statusTag).toHaveClass("shrink-0");
    expect(statusTag).toHaveClass(
      "bg-[var(--transparency-block)]",
      "text-[var(--text-secondary)]"
    );
  });

  it("shows the loading label while query results are still loading even if empty groups exist", () => {
    const state: AgentMentionSearchState = {
      status: "loading",
      query: "read",
      mode: "results",
      filter: "all",
      categories: [],
      groups: [
        {
          id: "opened_files",
          items: [],
          totalCount: 0,
          visibleCount: 0,
          hasMore: false,
          emptyLabel: "没有匹配到文件"
        },
        {
          id: "my_sessions",
          items: [],
          totalCount: 0,
          visibleCount: 0,
          hasMore: false,
          emptyLabel: "暂无会话"
        }
      ],
      error: null
    };

    render(
      <AgentFileMentionPalette
        state={state}
        highlightedKey={null}
        label="mention palette"
        loadingLabel="loading"
        emptyLabel="empty"
        errorLabel="error"
        tabHintLabel="hint"
        maxHeightPx={320}
        onHighlightChange={vi.fn()}
        onSelectItem={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectFilter={vi.fn()}
        onExpandGroup={vi.fn()}
        onCycleFilter={vi.fn()}
        onMoveSelection={vi.fn()}
      />
    );

    expect(screen.getByText("loading")).toBeVisible();
    expect(screen.queryByTestId("agent-mention-loading-banner")).toBeNull();
    expect(screen.queryByText("没有匹配到文件")).toBeNull();
  });

  it("shows a keyboard browse hint when the file tab has no opened or generated files", () => {
    const state: AgentMentionSearchState = {
      status: "ready",
      query: "",
      mode: "browse",
      filter: "file",
      categories: [
        { id: "all" },
        { id: "file" },
        { id: "app" },
        { id: "session" },
        { id: "issue" }
      ],
      groups: [
        {
          id: "opened_files",
          items: [],
          totalCount: 0,
          visibleCount: 0,
          hasMore: false,
          emptyLabel: "Dock 栏暂无已打开文件，输入关键词可搜索工作区文件"
        },
        {
          id: "agent_generated_files",
          items: [],
          totalCount: 0,
          visibleCount: 0,
          hasMore: false,
          emptyLabel: "暂无 Agent 生成的文件"
        }
      ],
      error: null
    };

    render(
      <AgentFileMentionPalette
        state={state}
        highlightedKey={null}
        label="mention palette"
        loadingLabel="loading"
        emptyLabel="empty"
        errorLabel="error"
        tabHintLabel="hint"
        maxHeightPx={320}
        onHighlightChange={vi.fn()}
        onSelectItem={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectFilter={vi.fn()}
        onExpandGroup={vi.fn()}
        onCycleFilter={vi.fn()}
        onMoveSelection={vi.fn()}
      />
    );

    expect(
      screen.getByText(
        "暂无已打开或 Agent 生成的文件，继续输入文件名可搜索本机文件"
      )
    ).toBeVisible();
    expect(
      screen.getByTestId("agent-gui-mention-palette-empty-state")
    ).toHaveAttribute("data-empty-state-icon", "keyboard");
    expect(screen.queryByText("我打开的文件")).toBeNull();
    expect(screen.queryByText("暂无 Agent 生成的文件")).toBeNull();
  });

  it("shows a search-more hint when the file tab already has visible files", () => {
    const state: AgentMentionSearchState = {
      status: "ready",
      query: "",
      mode: "browse",
      filter: "file",
      categories: [
        { id: "all" },
        { id: "file" },
        { id: "app" },
        { id: "session" },
        { id: "issue" }
      ],
      groups: [
        {
          id: "opened_files",
          items: [
            {
              kind: "file",
              href: "/workspace/README.md",
              path: "/workspace/README.md",
              name: "README.md",
              entryKind: "unknown",
              directoryPath: "/workspace"
            }
          ],
          totalCount: 1,
          visibleCount: 1,
          hasMore: false
        },
        {
          id: "agent_generated_files",
          items: [],
          totalCount: 0,
          visibleCount: 0,
          hasMore: false,
          emptyLabel: "暂无 Agent 生成的文件"
        }
      ],
      error: null
    };

    render(
      <AgentFileMentionPalette
        state={state}
        highlightedKey={null}
        label="mention palette"
        loadingLabel="loading"
        emptyLabel="empty"
        errorLabel="error"
        tabHintLabel="hint"
        maxHeightPx={320}
        onHighlightChange={vi.fn()}
        onSelectItem={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectFilter={vi.fn()}
        onExpandGroup={vi.fn()}
        onCycleFilter={vi.fn()}
        onMoveSelection={vi.fn()}
      />
    );

    expect(screen.getByText("README.md")).toBeVisible();
    expect(screen.getByText("继续输入文件名可搜索更多本机文件")).toBeVisible();
    expect(
      screen.queryByTestId("agent-gui-mention-palette-empty-state")
    ).toBeNull();
  });

  it("hides file subgroup titles while searching on the file tab", () => {
    const state: AgentMentionSearchState = {
      status: "ready",
      query: "quick",
      mode: "results",
      filter: "file",
      categories: [],
      groups: [
        {
          id: "opened_files",
          items: [
            {
              kind: "file",
              href: "/workspace/quickPhrases.ts",
              path: "/workspace/quickPhrases.ts",
              name: "quickPhrases.ts",
              entryKind: "unknown",
              directoryPath: "/workspace"
            }
          ],
          totalCount: 11,
          visibleCount: 1,
          hasMore: true
        }
      ],
      error: null
    };

    render(
      <AgentFileMentionPalette
        state={state}
        highlightedKey={null}
        label="mention palette"
        loadingLabel="loading"
        emptyLabel="empty"
        errorLabel="error"
        tabHintLabel="hint"
        maxHeightPx={320}
        onHighlightChange={vi.fn()}
        onSelectItem={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectFilter={vi.fn()}
        onExpandGroup={vi.fn()}
        onCycleFilter={vi.fn()}
        onMoveSelection={vi.fn()}
      />
    );

    expect(screen.getByText("quickPhrases.ts")).toBeVisible();
    expect(screen.getByText("展开更多 10 条")).toBeVisible();
    expect(screen.queryByText("我打开的文件")).toBeNull();
    expect(screen.queryByText("Agent 生成的文件")).toBeNull();
    expect(screen.queryByText("没有匹配到文件")).toBeNull();
    expect(screen.queryByTestId("agent-mention-group-divider")).toBeNull();
  });

  it("shows a no-match label when a file search returns no results", () => {
    const state: AgentMentionSearchState = {
      status: "ready",
      query: "missing",
      mode: "results",
      filter: "file",
      categories: [],
      groups: [],
      error: null
    };

    render(
      <AgentFileMentionPalette
        state={state}
        highlightedKey={null}
        label="mention palette"
        loadingLabel="loading"
        emptyLabel="根据你输入的内容搜索工作区文件"
        errorLabel="error"
        tabHintLabel="hint"
        maxHeightPx={320}
        onHighlightChange={vi.fn()}
        onSelectItem={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectFilter={vi.fn()}
        onExpandGroup={vi.fn()}
        onCycleFilter={vi.fn()}
        onMoveSelection={vi.fn()}
      />
    );

    expect(screen.getByText("没有匹配到文件")).toBeVisible();
  });

  it("does not render the custom scrollbar when mention results are not scrollable", () => {
    const state: AgentMentionSearchState = {
      status: "ready",
      query: "",
      mode: "results",
      filter: "all",
      categories: [],
      groups: [],
      error: null
    };

    render(
      <AgentFileMentionPalette
        state={state}
        highlightedKey={null}
        label="mention palette"
        loadingLabel="loading"
        emptyLabel="empty"
        errorLabel="error"
        tabHintLabel="hint"
        maxHeightPx={320}
        onHighlightChange={vi.fn()}
        onSelectItem={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectFilter={vi.fn()}
        onExpandGroup={vi.fn()}
        onCycleFilter={vi.fn()}
        onMoveSelection={vi.fn()}
      />
    );

    expect(screen.getByRole("listbox")).toHaveClass("max-h-[320px]");
    expect(
      screen.queryByTestId("agent-gui-mention-palette-scrollbar")
    ).toBeNull();
  });

  it("shows a fixed loading banner while keeping existing results visible", () => {
    const state: AgentMentionSearchState = {
      status: "loading",
      query: "image",
      mode: "results",
      filter: "all",
      categories: [],
      groups: [
        {
          id: "opened_files",
          items: [
            {
              kind: "file",
              href: "/workspace/assets/demo.png",
              path: "/workspace/assets/demo.png",
              name: "demo.png",
              entryKind: "file",
              directoryPath: "/workspace/assets",
              score: 99
            }
          ],
          totalCount: 1,
          visibleCount: 1,
          hasMore: false
        }
      ],
      error: null
    };

    render(
      <AgentFileMentionPalette
        state={state}
        highlightedKey="opened_files:file:/workspace/assets/demo.png"
        label="mention palette"
        loadingLabel="loading"
        emptyLabel="empty"
        errorLabel="error"
        tabHintLabel="hint"
        maxHeightPx={320}
        onHighlightChange={vi.fn()}
        onSelectItem={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectFilter={vi.fn()}
        onExpandGroup={vi.fn()}
        onCycleFilter={vi.fn()}
        onMoveSelection={vi.fn()}
      />
    );

    const loadingBanner = screen.getByTestId("agent-mention-loading-banner");
    expect(loadingBanner).toBeVisible();
    expect(loadingBanner).toHaveClass("border-b", "border-[var(--line-1)]");
    expect(screen.getByText("demo.png")).toBeVisible();
  });

  it("renders file mention rows with the palette file icon target", () => {
    const state: AgentMentionSearchState = {
      status: "ready",
      query: "report",
      mode: "results",
      filter: "file",
      categories: [],
      groups: [
        {
          id: "opened_files",
          items: [
            {
              kind: "file",
              href: "/workspace/report.docx",
              path: "/workspace/report.docx",
              name: "report.docx",
              entryKind: "file",
              directoryPath: "/workspace",
              score: 99
            }
          ],
          totalCount: 1,
          visibleCount: 1,
          hasMore: false
        }
      ],
      error: null
    };

    render(
      <AgentFileMentionPalette
        state={state}
        highlightedKey="opened_files:file:/workspace/report.docx"
        label="mention palette"
        loadingLabel="loading"
        emptyLabel="empty"
        errorLabel="error"
        tabHintLabel="hint"
        maxHeightPx={320}
        onHighlightChange={vi.fn()}
        onSelectItem={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectFilter={vi.fn()}
        onExpandGroup={vi.fn()}
        onCycleFilter={vi.fn()}
        onMoveSelection={vi.fn()}
      />
    );

    const fileRow = screen
      .getByText("report.docx")
      .closest('[data-agent-file-mention="true"]');

    expect(fileRow).toHaveAttribute("data-agent-file-visual-kind", "document");
    expect(
      fileRow?.querySelector(".agent-gui-node__mention-file-icon")
    ).not.toBeNull();
    expect(
      fileRow?.querySelector('[data-agent-mention-file-thumb="true"]')
    ).toBeNull();
  });

  it("renders agent generated folder back rows with a back navigation marker", () => {
    const state: AgentMentionSearchState = {
      status: "ready",
      query: "",
      mode: "browse",
      filter: "file",
      categories: [],
      groups: [
        {
          id: "agent_generated_files",
          items: [
            {
              kind: "file",
              href: "",
              path: "/workspace/demo/static",
              name: "返回",
              entryKind: "unknown",
              directoryPath: "/workspace/demo",
              mentionNavigation: "agent-generated-folder-back"
            }
          ],
          totalCount: 1,
          visibleCount: 1,
          hasMore: false
        }
      ],
      error: null
    };

    render(
      <AgentFileMentionPalette
        state={state}
        highlightedKey="agent_generated_files:agent-generated-folder-back:/workspace/demo/static"
        label="mention palette"
        loadingLabel="loading"
        emptyLabel="empty"
        errorLabel="error"
        tabHintLabel="hint"
        maxHeightPx={320}
        onHighlightChange={vi.fn()}
        onSelectItem={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectFilter={vi.fn()}
        onExpandGroup={vi.fn()}
        onCycleFilter={vi.fn()}
        onMoveSelection={vi.fn()}
      />
    );

    const backRow = screen
      .getByText("返回")
      .closest('[data-agent-file-mention="true"]');

    expect(backRow).toHaveAttribute(
      "data-agent-mention-navigation",
      "agent-generated-folder-back"
    );
    expect(backRow).toHaveAttribute("data-agent-file-visual-kind", "back");
    expect(
      backRow?.querySelector(".agent-gui-node__mention-file-icon")
    ).not.toBeNull();
  });

  it("renders image mention rows with thumbnails instead of default file icons", () => {
    const state: AgentMentionSearchState = {
      status: "ready",
      query: "diagram",
      mode: "results",
      filter: "file",
      categories: [],
      groups: [
        {
          id: "opened_files",
          items: [
            {
              kind: "file",
              href: "/workspace/assets/diagram.png",
              path: "/workspace/assets/diagram.png",
              name: "diagram.png",
              entryKind: "file",
              directoryPath: "/workspace/assets",
              thumbnailUrl: "data:image/png;base64,thumb"
            }
          ],
          totalCount: 1,
          visibleCount: 1,
          hasMore: false
        }
      ],
      error: null
    };

    render(
      <AgentFileMentionPalette
        state={state}
        highlightedKey={null}
        label="mention palette"
        loadingLabel="loading"
        emptyLabel="empty"
        errorLabel="error"
        tabHintLabel="hint"
        maxHeightPx={320}
        onHighlightChange={vi.fn()}
        onSelectItem={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectFilter={vi.fn()}
        onExpandGroup={vi.fn()}
        onCycleFilter={vi.fn()}
        onMoveSelection={vi.fn()}
      />
    );

    const fileRow = screen
      .getByText("diagram.png")
      .closest('[data-agent-file-mention="true"]');

    expect(
      fileRow?.querySelector('[data-agent-mention-file-thumb="true"] img')
    ).toHaveAttribute("src", "data:image/png;base64,thumb");
    expect(
      fileRow?.querySelector(".agent-gui-node__mention-file-icon")
    ).toBeNull();
  });

  it("separates mention groups with line-1 dividers", () => {
    const state: AgentMentionSearchState = {
      status: "ready",
      query: "",
      mode: "browse",
      filter: "all",
      categories: [],
      groups: [
        {
          id: "my_sessions",
          items: [],
          totalCount: 0,
          visibleCount: 0,
          hasMore: false
        },
        {
          id: "issues",
          items: [],
          totalCount: 0,
          visibleCount: 0,
          hasMore: false
        }
      ],
      error: null
    };

    render(
      <AgentFileMentionPalette
        state={state}
        highlightedKey={null}
        label="mention palette"
        loadingLabel="loading"
        emptyLabel="empty"
        errorLabel="error"
        tabHintLabel="hint"
        maxHeightPx={320}
        onHighlightChange={vi.fn()}
        onSelectItem={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectFilter={vi.fn()}
        onExpandGroup={vi.fn()}
        onCycleFilter={vi.fn()}
        onMoveSelection={vi.fn()}
      />
    );

    const groups = Array.from(document.querySelectorAll("section"));

    expect(groups).toHaveLength(2);
    expect(groups[0]).not.toHaveClass("border-t");
    expect(groups[1]).not.toHaveClass("border-t");
    const dividers = Array.from(
      document.querySelectorAll('[data-agent-mention-group-divider="true"]')
    );
    expect(dividers).toHaveLength(1);
    expect(dividers[0]).toHaveClass(
      "mx-3",
      "border-t",
      "border-[var(--line-1)]"
    );
    expect(screen.getByText("事项")).toHaveClass(
      "text-[13px]",
      "font-normal",
      "text-[var(--text-secondary)]"
    );
    expect(screen.getByText("暂无事项")).toHaveClass(
      "text-[13px]",
      "font-normal",
      "text-[var(--text-tertiary)]"
    );
  });

  it("hides a duplicate group heading when the active filter has one matching group", () => {
    const state: AgentMentionSearchState = {
      status: "ready",
      query: "",
      mode: "results",
      filter: "app",
      categories: [],
      groups: [
        {
          id: "apps",
          items: [
            {
              kind: "workspace-app",
              href: "mention://workspace-app?appId=automation",
              workspaceId: "room-1",
              targetId: "automation",
              appId: "automation",
              name: "Automation",
              iconUrl: "data:image/png;base64,automation",
              description:
                "Schedule and review recurring automation runs for this workspace."
            }
          ],
          totalCount: 1,
          visibleCount: 1,
          hasMore: false
        }
      ],
      error: null
    };

    render(
      <AgentFileMentionPalette
        state={state}
        highlightedKey={null}
        label="mention palette"
        loadingLabel="loading"
        emptyLabel="empty"
        errorLabel="error"
        tabHintLabel="hint"
        maxHeightPx={320}
        onHighlightChange={vi.fn()}
        onSelectItem={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectFilter={vi.fn()}
        onExpandGroup={vi.fn()}
        onCycleFilter={vi.fn()}
        onMoveSelection={vi.fn()}
      />
    );

    expect(screen.getByRole("tab", { name: "Apps" })).toBeVisible();
    expect(screen.getByRole("option", { name: /Automation/ })).toBeVisible();
    expect(
      document.querySelector('[data-agent-mention-app-icon="true"] img')
    ).toHaveAttribute("src", "data:image/png;base64,automation");
    expect(
      document.querySelector('[data-agent-mention-app-icon="true"]')
    ).toHaveClass("h-5", "w-5");
    expect(
      screen.getByText(
        "Schedule and review recurring automation runs for this workspace."
      )
    ).toBeVisible();
    expect(screen.getByText("Automation").parentElement).toHaveClass(
      "flex",
      "items-baseline",
      "gap-1"
    );
    expect(screen.getByText("Automation")).toHaveClass(
      "text-[13px]",
      "text-[var(--text-primary)]",
      "max-w-[40%]",
      "shrink-0"
    );
    expect(
      screen.getByText(
        "Schedule and review recurring automation runs for this workspace."
      )
    ).toHaveClass(
      "text-[13px]",
      "font-normal",
      "truncate",
      "text-[var(--text-secondary)]"
    );
    expect(screen.queryByText("automation")).toBeNull();
    expect(
      document.querySelector("section")?.textContent?.match(/\bApps\b/g) ?? []
    ).toHaveLength(0);
  });

  it("uses ui-system text tokens for mention palette text colors", () => {
    const source = readFileSync(
      resolve("agent-gui/agentGuiNode/AgentFileMentionPalette.tsx"),
      "utf8"
    );

    expect(source).not.toContain("text-foreground");
    expect(source).not.toContain("text-muted-foreground");
    expect(source).toContain("text-[var(--text-primary)]");
    expect(source).toContain("text-[var(--text-secondary)]");
    expect(source).toContain("text-[var(--text-tertiary)]");
  });

  it("shows only loading while browse results are refreshing", () => {
    const state: AgentMentionSearchState = {
      status: "loading",
      query: "",
      mode: "browse",
      filter: "all",
      categories: [{ id: "all" }, { id: "session" }],
      groups: [
        {
          id: "my_sessions",
          items: [
            {
              kind: "session",
              href: "tsh://room/room-1/session/session-1",
              workspaceId: "room-1",
              targetId: "session-1",
              name: "Alice & Codex 看看目录",
              title: "看看目录",
              scope: "my_sessions",
              initiatorName: "Alice",
              agentName: "Codex",
              status: "failed"
            }
          ],
          totalCount: 1,
          visibleCount: 1,
          hasMore: false
        }
      ],
      error: null
    };

    render(
      <AgentFileMentionPalette
        state={state}
        highlightedKey="my_sessions:session:session-1"
        label="mention palette"
        loadingLabel="loading"
        emptyLabel="empty"
        errorLabel="error"
        tabHintLabel="hint"
        maxHeightPx={320}
        onHighlightChange={vi.fn()}
        onSelectItem={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectFilter={vi.fn()}
        onExpandGroup={vi.fn()}
        onCycleFilter={vi.fn()}
        onMoveSelection={vi.fn()}
      />
    );

    expect(screen.getByText("loading")).toBeVisible();
    expect(screen.queryByTestId("agent-mention-loading-banner")).toBeNull();
    expect(screen.queryByText("Alice & Codex")).toBeNull();
  });

  it("runs the footer shortcut actions when the hint controls are clicked", () => {
    const state: AgentMentionSearchState = {
      status: "ready",
      query: "",
      mode: "results",
      filter: "all",
      categories: [],
      groups: [
        {
          id: "opened_files",
          items: [
            {
              kind: "file",
              href: "/workspace/assets/demo.png",
              path: "/workspace/assets/demo.png",
              name: "demo.png",
              entryKind: "file",
              directoryPath: "/workspace/assets",
              score: 99
            }
          ],
          totalCount: 1,
          visibleCount: 1,
          hasMore: false
        }
      ],
      error: null
    };
    const onCycleFilter = vi.fn();
    const onMoveSelection = vi.fn();

    render(
      <AgentFileMentionPalette
        state={state}
        highlightedKey="opened_files:file:/workspace/assets/demo.png"
        label="mention palette"
        loadingLabel="loading"
        emptyLabel="empty"
        errorLabel="error"
        tabHintLabel="hint"
        maxHeightPx={320}
        onHighlightChange={vi.fn()}
        onSelectItem={vi.fn()}
        onSelectCategory={vi.fn()}
        onSelectFilter={vi.fn()}
        onExpandGroup={vi.fn()}
        onCycleFilter={onCycleFilter}
        onMoveSelection={onMoveSelection}
      />
    );

    const hint = screen.getByTestId("agent-gui-mention-palette-hint");

    fireEvent.click(within(hint).getByRole("button", { name: "切换分类" }));
    fireEvent.click(within(hint).getByRole("button", { name: "↑ 切换选中" }));
    fireEvent.click(within(hint).getByRole("button", { name: "↓ 切换选中" }));

    expect(onCycleFilter).toHaveBeenCalledTimes(1);
    expect(onMoveSelection).toHaveBeenNthCalledWith(1, -1);
    expect(onMoveSelection).toHaveBeenNthCalledWith(2, 1);
  });

  it("keeps the shortcut hint visible in constrained mention panels", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.tsh-underline-tabs\.agent-gui-node__mention-palette-tabs\s*{[^}]*height:\s*41px[^}]*padding:\s*8px 16px 0/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__mention-palette-header\s*{[^}]*padding:\s*8px 0 0/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__mention-palette-footer\s*{[^}]*min-height:\s*36px/s
    );
    expect(css).not.toMatch(
      /\.agent-gui-node__mention-palette-hint[^{]*{[^}]*display:\s*none/s
    );
  });

  it("keeps embedded message-center approval prompts within their card", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-prompt-card\s*{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*max-width:\s*100%/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-prompt-card\s*{[^}]*gap:\s*12px/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-prompt-card\s*{[^}]*border-radius:\s*12px/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-prompt-card\s*{[^}]*padding:\s*12px 16px 16px/s
    );
    expect(css).toMatch(
      /\[data-testid="workspace-agent-message-center"\][\s\S]*?\.agent-gui-conversation__interactive-prompt-card\s*{[^}]*padding:\s*12px/s
    );
    expect(css).toMatch(
      /\[data-testid="workspace-agent-message-center"\][\s\S]*?\.agent-gui-conversation__interactive-prompt-card\s*{[^}]*border-radius:\s*12px/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-option-button\s*{[^}]*padding:\s*8px 8px 8px 12px/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-option-button:has\([^}]*padding-right:\s*8px/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-option-shortcut\s*{[^}]*right:\s*8px/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-option-spinner\s*{[^}]*right:\s*8px/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-option-shortcut\s*{[^}]*top:\s*50%[^}]*transform:\s*translateY\(-50%\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-option-spinner\s*{[^}]*top:\s*50%[^}]*transform:\s*translateY\(-50%\)/s
    );
    expect(css).toMatch(
      /\[data-testid="workspace-agent-message-center"\][\s\S]*?\.agent-gui-conversation__interactive-prompt-question,[\s\S]*?\[data-testid="workspace-agent-message-center"\][\s\S]*?\.agent-gui-conversation__interactive-option-title,[\s\S]*?\[data-testid="workspace-agent-message-center"\][\s\S]*?\.agent-gui-conversation__interactive-option-description\s*{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-option-button:has\([\s\S]*?\.agent-gui-conversation__interactive-option-shortcut,[\s\S]*?\.agent-gui-conversation__interactive-option-spinner[\s\S]*?\)[\s\S]*?\.agent-gui-conversation__interactive-option-title,[\s\S]*?\.agent-gui-conversation__interactive-option-button:has\([\s\S]*?\.agent-gui-conversation__interactive-option-shortcut,[\s\S]*?\.agent-gui-conversation__interactive-option-spinner[\s\S]*?\)[\s\S]*?\.agent-gui-conversation__interactive-option-description\s*{[^}]*max-width:\s*calc\(100%\s*-\s*112px\)/s
    );
    expect(css).toMatch(
      /\[data-message-center-item-id\]\.agent-gui-edge-glow\s*{[^}]*overflow:\s*hidden/s
    );
    expect(css).toMatch(
      /html\[data-theme="light"\]\s+\[data-message-center-item-id\]\.agent-gui-edge-glow\s*{[^}]*--agent-gui-star-border-color:\s*var\(--tutti-purple\)/s
    );
    expect(css).toMatch(
      /html\[data-theme="light"\]\s+\[data-message-center-item-id\]\.agent-gui-edge-glow\s*{[^}]*--agent-gui-star-border-mid-color:\s*color-mix\(\s*in srgb,\s*var\(--tutti-purple\) 48%,\s*transparent\s*\)/s
    );
    expect(css).toMatch(
      /html\[data-theme="light"\]\s+\[data-message-center-item-id\]\.agent-gui-edge-glow\s*{[^}]*--agent-gui-star-border-shadow:\s*drop-shadow\(\s*0 0 6px color-mix\(in srgb, var\(--tutti-purple\) 58%, transparent\)\s*\)/s
    );
    for (const selector of [
      "interactive-prompt-lead",
      "interactive-option-button",
      "interactive-option-display",
      "interactive-option-title",
      "interactive-option-shortcut"
    ]) {
      expect(css).toMatch(
        new RegExp(
          `\\.agent-gui-conversation__${selector}\\s*{[^}]*font-weight:\\s*500`,
          "s"
        )
      );
      expect(css).not.toMatch(
        new RegExp(
          `\\.agent-gui-conversation__${selector}\\s*{[^}]*font-weight:\\s*600`,
          "s"
        )
      );
    }
  });

  it("uses border-focus for waiting agent activity card outlines", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.workspace-agents-status-panel__activity\.agent-gui-edge-glow\s*{[^}]*border-color:\s*var\(--border-focus\)/s
    );
  });

  it("keeps raised status panels below global tooltips", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.workspace-agents-status-panel\[data-layer="raised"\]\s*{[^}]*z-index:\s*var\(--z-toast,\s*100300\)/s
    );
    expect(css).not.toMatch(
      /\.workspace-agents-status-panel\[data-layer="raised"\]\s*{[^}]*z-index:\s*100300/s
    );
  });

  it("lets the project rail header scroll with the conversation list", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");
    const nodeViewSource = readFileSync(
      resolve("agent-gui/agentGuiNode/AgentGUINodeView.tsx"),
      "utf8"
    );
    const projectRailHeaderRule =
      css.match(/\.agent-gui-node__project-rail-header\s*{[^}]*}/s)?.[0] ?? "";
    const projectRailTitleRule =
      css.match(/\.agent-gui-node__project-rail-title\s*{[^}]*}/s)?.[0] ?? "";

    expect(projectRailHeaderRule).toMatch(/display:\s*flex/);
    expect(projectRailHeaderRule).not.toMatch(/position:\s*sticky/);
    expect(projectRailHeaderRule).not.toMatch(/\btop:\s*0/);
    expect(projectRailHeaderRule).not.toMatch(/\bz-index:/);
    expect(projectRailHeaderRule).not.toMatch(/\bbackground:/);
    expect(projectRailTitleRule).toMatch(/font-size:\s*13px/);
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section\s*\+\s*\.agent-gui-node__project-rail-header\s*{[^}]*margin-top:\s*24px/s
    );
    expect(nodeViewSource).toMatch(/<Fragment key=\{section\.id\}>/);
    expect(nodeViewSource).toMatch(/const showProjectRailHeader\s*=/);
    expect(nodeViewSource).toMatch(/section\.kind !== "pinned"/);
    expect(nodeViewSource).toMatch(
      /groupedConversations\[sectionIndex - 1\]\?\.kind === "pinned"/
    );
  });

  it("gives project section headers a hover-only background", () => {
    const nodeViewSource = readFileSync(
      resolve("agent-gui/agentGuiNode/AgentGUINodeView.tsx"),
      "utf8"
    );
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(nodeViewSource).toMatch(/data-kind=\{section\.kind\}/);
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section-header\s*{[^}]*border-radius:\s*6px[^}]*background-color:\s*transparent[^}]*padding:\s*4px 6px 4px 10px[^}]*transition:\s*background-color 140ms ease/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section-label\s*{[^}]*font-size:\s*13px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section\[data-kind="project"\][\s\S]*?>\s*\.agent-gui-node__conversation-section-header:hover\s*{[^}]*background-color:\s*var\(--agent-gui-surface-hover\)/s
    );
    expect(css).not.toMatch(
      /\.agent-gui-node__conversation-section\[data-kind="project"\][\s\S]*?>\s*\.agent-gui-node__conversation-section-header:focus-within/
    );
  });

  it("swaps project folder icons for chevrons only on hover", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__conversation-section-toggle\s*{[^}]*position:\s*relative[^}]*gap:\s*0/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section-chevron\s*{[^}]*position:\s*absolute[^}]*left:\s*0[^}]*opacity:\s*0[^}]*pointer-events:\s*none/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section\[data-kind="project"\][\s\S]*?>\s*\.agent-gui-node__conversation-section-header:hover[\s\S]*?\.agent-gui-node__conversation-section-chevron\s*{[^}]*opacity:\s*1/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section-label-icon\s*{[^}]*width:\s*12px[^}]*height:\s*12px[^}]*transition:\s*opacity 140ms ease/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section\[data-kind="project"\][\s\S]*?>\s*\.agent-gui-node__conversation-section-header:hover[\s\S]*?\.agent-gui-node__conversation-section-label-icon\s*{[^}]*opacity:\s*0/s
    );
  });

  it("lets project and pinned conversation row backgrounds span the section width", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__conversation-section-items\s*{[^}]*padding-left:\s*14px[^}]*padding-top:\s*8px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section\[data-kind="project"\]\s+\.agent-gui-node__conversation-section-items\s*{[^}]*padding-left:\s*0[^}]*padding-top:\s*4px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section\[data-kind="project"\]\s+\.agent-gui-node__conversation-select\s*{[^}]*padding-left:\s*26px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section\[data-kind="pinned"\]\s+\.agent-gui-node__conversation-section-items\s*{[^}]*padding-left:\s*0/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section\[data-kind="pinned"\]\s+\.agent-gui-node__conversation-select\s*{[^}]*padding-left:\s*26px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section\[data-kind="conversations"\]\s+\.agent-gui-node__conversation-section-items\s*{[^}]*padding-left:\s*0/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section\[data-kind="conversations"\]\s+\.agent-gui-node__conversation-select\s*{[^}]*padding-left:\s*26px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section-items-inner\s*{[^}]*gap:\s*4px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section\[data-kind="project"\]\s+\.agent-gui-node__conversation-section-items-inner\s*{[^}]*gap:\s*2px/s
    );
  });

  it("reserves space for conversation row actions so titles truncate", () => {
    const nodeViewSource = readFileSync(
      resolve("agent-gui/agentGuiNode/AgentGUINodeView.tsx"),
      "utf8"
    );
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__conversation-list\s*{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*auto/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section\s*{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section\s*\+\s*\.agent-gui-node__conversation-section\s*{[^}]*margin-top:\s*12px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section\[data-kind="project"\]\s*\+\s*\.agent-gui-node__conversation-section\[data-kind="project"\]\s*{[^}]*margin-top:\s*2px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section\[data-kind="pinned"\]\s*\+\s*\.agent-gui-node__conversation-section\[data-kind="conversations"\],[\s\S]*?\.agent-gui-node__conversation-section\[data-kind="project"\]\s*\+\s*\.agent-gui-node__conversation-section\[data-kind="conversations"\]\s*{[^}]*margin-top:\s*24px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section-items\s*{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-item\s*{[^}]*width:\s*100%[^}]*max-width:\s*100%[^}]*height:\s*32px[^}]*min-height:\s*32px[^}]*border-radius:\s*6px[^}]*overflow:\s*hidden/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-select\s*{[^}]*width:\s*100%[^}]*max-width:\s*100%[^}]*min-width:\s*0[^}]*overflow:\s*hidden/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-title\s*{[^}]*overflow:\s*hidden[^}]*color:\s*var\(--text-primary\)[^}]*font-size:\s*13px[^}]*font-weight:\s*500[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-item:hover\s+\.agent-gui-node__conversation-select[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s*0[\s\S]*?padding-right:\s*72px/s
    );
    expect(css).not.toMatch(
      /\.agent-gui-node__conversation-item:focus-within\s+\.agent-gui-node__conversation-select[\s\S]*?grid-template-columns/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-item\[data-pending-delete="true"\][\s\S]*?\.agent-gui-node__conversation-select\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*0[^}]*padding-right:\s*min\(96px,\s*calc\(100%\s*-\s*24px\)\)/s
    );
    expect(css).not.toMatch(
      /\.agent-gui-node__conversation-item\[data-pinned="true"\]\s+\.agent-gui-node__conversation-actions,\s*\.agent-gui-node__conversation-item:hover/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-actions\s*{[^}]*right:\s*4px[^}]*justify-content:\s*flex-start[^}]*gap:\s*0[^}]*min-width:\s*48px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-delete-button,\s*\.agent-gui-node__conversation-pin-button\s*{[^}]*background:\s*transparent[^}]*background-color:\s*transparent[^}]*color:\s*var\(--text-tertiary\)/s
    );
    expect(css).not.toMatch(
      /\.agent-gui-node__conversation-delete-button,\s*\.agent-gui-node__conversation-pin-button\s*{[^}]*width:\s*28px/s
    );
    expect(nodeViewSource).toMatch(
      /<BareIconButton[\s\S]*className=\{styles\.conversationPinButton\}[\s\S]*size="md"[\s\S]*<BareIconButton[\s\S]*className=\{[\s\S]*?styles\.conversationDeleteButton[\s\S]*?\}[\s\S]*size="md"/
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-actions\s+>\s+button\.agent-gui-node__conversation-pin-button:not\(:disabled\):hover,\s*\.agent-gui-node__conversation-actions\s+>\s+button\.agent-gui-node__conversation-pin-button:not\(:disabled\):focus-visible,\s*\.agent-gui-node__conversation-actions\s+>\s+button\.agent-gui-node__conversation-pin-button:not\(:disabled\):active\s*{[^}]*background:\s*transparent[^}]*background-color:\s*transparent/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-item\[data-pinned="true"\]\s+\.agent-gui-node__conversation-pin-button\s*{[^}]*color:\s*var\(--agent-gui-accent\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-actions\s+>\s+button\.agent-gui-node__conversation-pin-button:not\(:disabled\):hover,\s*\.agent-gui-node__conversation-actions\s+>\s+button\.agent-gui-node__conversation-pin-button:not\(:disabled\):focus-visible,\s*\.agent-gui-node__conversation-actions\s+>\s+button\.agent-gui-node__conversation-pin-button:not\(:disabled\):active\s*{[^}]*color:\s*var\(--agent-gui-accent\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-actions\s+>\s+button\.agent-gui-node__conversation-pin-button:not\(:disabled\):hover\s+svg,\s*\.agent-gui-node__conversation-actions\s+>\s+button\.agent-gui-node__conversation-pin-button:not\(:disabled\):focus-visible\s+svg,\s*\.agent-gui-node__conversation-actions\s+>\s+button\.agent-gui-node__conversation-pin-button:not\(:disabled\):active\s+svg\s*{[^}]*color:\s*var\(--agent-gui-accent\)[^}]*fill:\s*currentColor/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-actions\s+>\s+button\.agent-gui-node__conversation-delete-button:not\(:disabled\):hover,\s*\.agent-gui-node__conversation-actions\s+>\s+button\.agent-gui-node__conversation-delete-button:not\(\s*:disabled\s*\):focus-visible,\s*\.agent-gui-node__conversation-actions\s+>\s+button\.agent-gui-node__conversation-delete-button:not\(:disabled\):active\s*{[^}]*background:\s*transparent[^}]*background-color:\s*transparent[^}]*color:\s*var\(--agent-gui-danger,\s*var\(--state-danger\)\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-actions\s+>\s+button\.agent-gui-node__conversation-delete-button:not\(:disabled\):hover\s+svg,\s*\.agent-gui-node__conversation-actions\s+>\s+button\.agent-gui-node__conversation-delete-button:not\(\s*:disabled\s*\):focus-visible\s+svg,\s*\.agent-gui-node__conversation-actions\s+>\s+button\.agent-gui-node__conversation-delete-button:not\(:disabled\):active\s+svg\s*{[^}]*color:\s*var\(--agent-gui-danger,\s*var\(--state-danger\)\)[^}]*fill:\s*currentColor/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-item:hover\s+\.agent-gui-node__conversation-meta[\s\S]*?width:\s*0[\s\S]*?min-width:\s*0[\s\S]*?margin-right:\s*0/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-meta\[data-kind="time"\]\s*{[^}]*min-width:\s*max-content[^}]*white-space:\s*nowrap/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-time\s*{[^}]*font-size:\s*11px[^}]*white-space:\s*nowrap/s
    );
  });

  it("keeps composer chrome notices inset by 12px", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__composer-input-group\s*>\s*\.agent-gui-chrome__session-chrome\s*{[^}]*margin-right:\s*12px[^}]*margin-left:\s*12px/s
    );
  });

  it("insets bottom dock chrome notices further when stacked above composer notices", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__bottom-dock\s*>\s*\.agent-gui-chrome__session-chrome:has\(\s*\+\s*\.agent-gui-node__composer\s+\.agent-gui-node__composer-input-group\s*>\s*\.agent-gui-chrome__session-chrome\s*\)\s*{[^}]*margin-right:\s*36px[^}]*margin-left:\s*36px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__bottom-dock\s*>\s*\.agent-gui-chrome__session-chrome:has\(\s*\+\s*\.agent-gui-node__composer\s+\.agent-gui-node__composer-input-group\s*>\s*\.agent-gui-chrome__session-chrome\s*\)\s*\+\s*\.agent-gui-node__composer\s+\.agent-gui-node__composer-input-group\s*>\s*\.agent-gui-chrome__session-chrome\s*{[^}]*margin-right:\s*12px[^}]*margin-left:\s*12px/s
    );
  });

  it("uses status danger for chrome danger notices", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-chrome__card--danger\s*{[^}]*border-color:\s*color-mix\(\s*in srgb,\s*var\(--status-danger,\s*var\(--state-danger\)\)\s*16%,\s*transparent\s*\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-chrome__card--danger\s+\.agent-gui-chrome__icon,[\s\S]*?\.agent-gui-chrome__card--danger\s+\.agent-gui-chrome__message,[\s\S]*?\.agent-gui-chrome__card--danger\s+\.agent-gui-chrome__expand-cue\s*{[^}]*color:\s*var\(--status-danger,\s*var\(--state-danger\)\)/s
    );
  });

  it("uses package-owned status tokens for agent gui chrome", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__shell\s*{[^}]*--agent-gui-package-success:\s*rgb\(34 197 94\)[^}]*--agent-gui-package-warning:\s*rgb\(234 121 8\)[^}]*--agent-gui-package-danger:\s*rgb\(220 38 38\)[^}]*--agent-gui-success:\s*var\(--agent-gui-package-success\)[^}]*--agent-gui-warning:\s*var\(--agent-gui-package-warning\)[^}]*--agent-gui-danger:\s*var\(--agent-gui-package-danger\)/s
    );
    expect(css).toMatch(
      /\[data-testid="workspace-agent-message-center"\]\s*{[^}]*--agent-gui-package-success:\s*rgb\(34 197 94\)[^}]*--agent-gui-package-warning:\s*rgb\(234 121 8\)[^}]*--agent-gui-package-danger:\s*rgb\(220 38 38\)[^}]*--agent-gui-success:\s*var\(--agent-gui-package-success\)[^}]*--agent-gui-warning:\s*var\(--agent-gui-package-warning\)[^}]*--agent-gui-danger:\s*var\(--agent-gui-package-danger\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-menu-content\s*{[^}]*--agent-gui-surface-raised:\s*var\(--background-fronted\)[^}]*--agent-gui-border-subtle:\s*var\(--line-2\)[^}]*--agent-gui-package-success:\s*rgb\(34 197 94\)[^}]*--agent-gui-success:\s*var\(--agent-gui-package-success\)/s
    );
  });

  it("uses the package success token for ask-for-approval permission triggers", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__composer-menu-trigger\[data-permission-tone="success"\],[\s\S]*?\.agent-gui-node__composer-menu-trigger\[data-permission-tone="success"\]\s*>\s*svg\s*{[^}]*color:\s*var\(--agent-gui-success\)/s
    );
  });

  it("uses tutti purple for composer approval menu accents", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__composer-menu-trigger\[data-permission-tone="accent"\],[\s\S]*?\.agent-gui-node__composer-menu-trigger\[data-permission-tone="accent"\]\s*>\s*svg\s*{[^}]*color:\s*var\(--tutti-purple\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-menu-content\s*{[^}]*--accent:\s*var\(--tutti-purple\)[^}]*--agent-gui-package-accent:\s*var\(--tutti-purple\)[^}]*--agent-gui-package-accent-strong:\s*var\(--tutti-purple\)/s
    );
  });

  it("keeps conversation prompt titles on the carried TSH medium weight", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-prompt-lead\s*{[^}]*font-size:\s*15px[^}]*font-weight:\s*500/s
    );
  });

  it("keeps empty hero titles at medium weight", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__empty-hero-title\s*{[^}]*font-weight:\s*500/s
    );
  });

  it("sets the empty hero provider name in Merriweather bold italic", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__empty-hero-provider\s*{[^}]*font-family:\s*Merriweather,\s*Georgia,\s*serif[^}]*font-style:\s*italic[^}]*font-weight:\s*700/s
    );
  });

  it("uses the product primary text token for the detail header title", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__detail-header-title\s*{[^}]*color:\s*var\(--text-primary\)[^}]*font-size:\s*15px/s
    );
  });

  it("ships self-contained status dot styles for package hosts", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__layout\s+\[data-slot="status-dot"\],\s*\[data-testid="workspace-agent-message-center"\]\s+\[data-slot="status-dot"\]\s*{[^}]*display:\s*inline-flex[^}]*border-radius:\s*999px[^}]*background:\s*var\(--agent-gui-status-dot-color\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__layout\s+\[data-slot="status-dot"\]\[data-size="md"\],\s*\[data-testid="workspace-agent-message-center"\]\s+\[data-slot="status-dot"\]\[data-size="md"\]\s*{[^}]*width:\s*10px[^}]*height:\s*10px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__layout\s+\[data-slot="status-dot"\]\[data-tone="green"\],\s*\[data-testid="workspace-agent-message-center"\]\s+\[data-slot="status-dot"\]\[data-tone="green"\]\s*{[^}]*--agent-gui-status-dot-color:\s*var\(--agent-gui-success,\s*var\(--state-success\)\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__layout\s+\[data-slot="status-dot"\]\[data-pulse="true"\],\s*\[data-testid="workspace-agent-message-center"\]\s+\[data-slot="status-dot"\]\[data-pulse="true"\]\s*{[^}]*animation:\s*agent-gui-status-dot-pulse\s+1\.8s\s+ease-in-out\s+infinite/s
    );
    expect(css).toMatch(/@keyframes\s+agent-gui-status-dot-pulse/s);
    expect(css).toMatch(/--agent-gui-package-accent:\s*var\(--accent-codex\)/s);
    expect(css).toMatch(
      /--agent-gui-accent:\s*var\(--agent-gui-package-accent\)/s
    );
    expect(css).toMatch(
      /--agent-gui-accent-strong:\s*var\(--agent-gui-package-accent-strong\)/s
    );
  });

  it("ships self-contained message center action styles for package hosts", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.workspace-agent-message-center__card\s*{[^}]*display:\s*flex[^}]*border:\s*1px solid var\(--line-2\)[^}]*background:\s*var\(--background-fronted\)/s
    );
    expect(css).toMatch(
      /\.workspace-agent-message-center__card\[data-waiting="true"\]\s*{[^}]*border-color:\s*var\(--tutti-purple-border\)[^}]*background:\s*var\(--tutti-purple-bg\)/s
    );
    expect(css).toMatch(
      /\.workspace-agent-message-center__open-chat-button\s*{[^}]*background:\s*transparent[^}]*background-color:\s*transparent[^}]*color:\s*var\(--agent-gui-accent\)/s
    );
    expect(css).toMatch(
      /\.workspace-agent-message-center__open-chat-button:hover,\s*\.workspace-agent-message-center__open-chat-button:focus-visible,\s*\.workspace-agent-message-center__open-chat-button:active\s*{[^}]*background:\s*transparent[^}]*background-color:\s*transparent[^}]*color:\s*var\(--agent-gui-accent\)/s
    );
    expect(css).toMatch(
      /\.workspace-agent-message-center__project-info-button:hover,\s*\.workspace-agent-message-center__project-info-button:focus-visible\s*{[^}]*background:\s*var\(--transparency-hover\)[^}]*color:\s*var\(--text-primary\)/s
    );
  });

  it("uses product color tokens across conversation flow surfaces", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-prompt-lead\s*{[^}]*color:\s*var\(--text-primary\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-prompt-actions button\s*{[^}]*border:\s*1px solid var\(--line-2\)[^}]*background:\s*var\(--background-fronted\)[^}]*color:\s*var\(--text-primary\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__assistant-markdown\s*{[^}]*color:\s*var\(--agent-conversation-text,\s*var\(--text-primary\)\)/s
    );
    expect(css).toMatch(
      /\.workspace-agents-status-panel__detail-user-message\.agent-gui-conversation__user-message-bubble\s*{[^}]*background:\s*var\(--agent-conversation-user-bg,\s*var\(--transparency-block\)\)[^}]*color:\s*var\(--agent-conversation-user-text,\s*var\(--text-primary\)\)/s
    );
    expect(css).toMatch(
      /\[data-agent-file-mention="true"\]\[data-agent-mention-kind="file"\]\.tsh-agent-object-token--file\s*{[^}]*color:\s*var\(--folder\)/s
    );
    expect(css).toMatch(
      /\[data-agent-mention-kind="workspace-app"\]\.tsh-agent-object-token--entity\s*{[^}]*color:\s*var\(--tutti-purple\)/s
    );
    expect(css).toMatch(
      /\.workspace-agents-status-panel__activity-summary\s+\.workspace-agents-status-panel__detail-markdown\s+a,[\s\S]*?\.workspace-agents-status-panel__detail-markdown\s+code\s+a\s*{[^}]*color:\s*var\(--tutti-purple\)/s
    );
  });

  it("uses accent blue for editable workspace app mentions", () => {
    const nodeViewSource = readFileSync(
      resolve("agent-gui/agentGuiNode/agentRichText/AgentMentionNodeView.tsx"),
      "utf8"
    );
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");
    const workspaceAppFallbackIconRule =
      css.match(
        /\[data-agent-mention-kind="workspace-app"\]\s+\[data-agent-mention-app-icon="true"\]\s+\.tsh-agent-object-token__kind-icon\s*{[^}]*}/s
      )?.[0] ?? "";

    expect(nodeViewSource).toContain("text-[var(--accent)]");
    expect(nodeViewSource).toContain("text-[13px]");
    expect(nodeViewSource).toContain("relative grid size-4");
    expect(nodeViewSource).not.toContain("size-[18px]");
    expect(nodeViewSource).not.toContain(
      "text-[var(--rich-text-mention-issue)]"
    );
    expect(workspaceAppFallbackIconRule).toMatch(/width:\s*16px/);
    expect(workspaceAppFallbackIconRule).toMatch(/height:\s*16px/);
    expect(workspaceAppFallbackIconRule).toMatch(
      /mask-image:\s*url\("\.\/assets\/icons\/product-filled\.svg"\)/
    );
  });

  it("keeps queued prompt mentions neutral instead of category colored", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");
    const queuedAnyMentionRule =
      css.match(
        /\.agent-gui-node__composer-queued-prompt-markdown\s+\[data-agent-file-mention="true"\]\s*{[^}]*}/s
      )?.[0] ?? "";
    const queuedEntityMentionRule =
      css.match(
        /\.agent-gui-node__composer-queued-prompt-markdown\s+\[data-agent-file-mention="true"\]\.tsh-agent-object-token--entity\s*{[^}]*}/s
      )?.[0] ?? "";
    const queuedAppMentionRule =
      css.match(
        /\.agent-gui-node__composer-queued-prompt-markdown\s+\[data-agent-mention-kind="workspace-app"\]\.tsh-agent-object-token--entity\s*{[^}]*}/s
      )?.[0] ?? "";
    const queuedMentionPartsRule =
      css.match(
        /\.agent-gui-node__composer-queued-prompt-markdown\s+\[data-agent-file-mention="true"\]\s+\.tsh-agent-object-token__kind,[\s\S]*?\[data-agent-mention-app-icon="true"\]\s*{[^}]*}/s
      )?.[0] ?? "";

    expect(queuedAnyMentionRule).toMatch(/color:\s*inherit/);
    expect(queuedEntityMentionRule).toMatch(/color:\s*inherit/);
    expect(queuedAppMentionRule).toMatch(/color:\s*inherit/);
    expect(queuedMentionPartsRule).toMatch(/color:\s*inherit/);
    expect(queuedAppMentionRule).not.toMatch(/var\(--accent\)/);
  });

  it("keeps standalone chrome notice text at regular weight", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-chrome__notice-title\s*{[^}]*font-weight:\s*400/s
    );
    expect(css).toMatch(
      /\.agent-gui-chrome__notice-description\s*{[^}]*font-weight:\s*400/s
    );
  });

  it("removes object token offset when markdown contains only a mention", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\[data-agent-mention-only="true"\]\s+\.tsh-agent-object-token--file,[\s\S]*?\[data-agent-mention-only="true"\]\s+\.tsh-agent-object-token--entity\s*{[^}]*top:\s*0/s
    );
  });

  it("lets entity mention tokens grow with large surrounding text", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");
    const entityTokenRule =
      css.match(/\.tsh-agent-object-token--entity\s*{[^}]*}/s)?.[0] ?? "";

    expect(entityTokenRule).toMatch(/min-height:\s*20px/);
    expect(entityTokenRule).toMatch(/line-height:\s*inherit/);
    expect(entityTokenRule).not.toMatch(/(?:^|[;\s])height:\s*20px/);
  });

  it("gives workspace issue mention tokens an issue icon mask", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");
    const issueIconRule =
      css.match(
        /\[data-agent-mention-kind="workspace-issue"\]\.tsh-agent-object-token--entity\s+\.tsh-agent-object-token__kind-icon\s*{[^}]*}/s
      )?.[0] ?? "";

    expect(issueIconRule).toMatch(/issue-filled\.svg/);
    expect(issueIconRule).toMatch(/width:\s*16px/);
    expect(issueIconRule).toMatch(/height:\s*16px/);
  });

  it("keeps file and folder mention icons at 16px with folder token color", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");
    const shellRule =
      css.match(/\.agent-gui-node__shell\s*{[^}]*}/s)?.[0] ?? "";
    const paletteRule =
      Array.from(css.matchAll(/\.agent-gui-node__mention-palette\s*{[^}]*}/gs))
        .map((match) => match[0])
        .find((rule) => rule.includes("--agent-mention-file-icon-size")) ?? "";
    const fileTokenRule =
      Array.from(css.matchAll(/\.tsh-agent-object-token--file\s*{[^}]*}/gs))
        .map((match) => match[0])
        .find((rule) => rule.includes("color:")) ?? "";
    const fileIconRule =
      css.match(
        /\.tsh-agent-object-token--file\s+\.tsh-agent-object-token__icon\s*{[^}]*}/s
      )?.[0] ?? "";
    const paletteFileIconRule =
      css.match(/\.agent-gui-node__mention-file-icon\s*{[^}]*}/s)?.[0] ?? "";
    const backNavigationIconRule =
      css.match(
        /\[data-agent-file-mention="true"\]\[data-agent-mention-kind="file"\]\[data-agent-file-visual-kind="back"\]\s+\.agent-gui-node__mention-file-icon\s*{[^}]*}/s
      )?.[0] ?? "";

    expect(shellRule).toMatch(/--agent-mention-file-icon-size:\s*16px/);
    expect(paletteRule).toMatch(/--agent-mention-file-icon-size:\s*16px/);
    expect(fileTokenRule).toMatch(/color:\s*var\(--folder\)/);
    expect(fileTokenRule).toMatch(/box-sizing:\s*border-box/);
    expect(fileTokenRule).toMatch(/padding:\s*2px 4px/);
    expect(fileTokenRule).toMatch(/border:\s*1px solid transparent/);
    expect(fileTokenRule).toMatch(/border-radius:\s*4px/);
    expect(fileTokenRule).toMatch(/line-height:\s*20px/);
    expect(fileTokenRule).not.toMatch(/height:\s*24px/);
    expect(fileTokenRule).not.toMatch(/min-height:\s*24px/);
    expect(paletteFileIconRule).toMatch(/background-color:\s*var\(--folder\)/);
    expect(backNavigationIconRule).toMatch(/arrow-left-filled\.svg/);
    expect(backNavigationIconRule).toMatch(
      /background-color:\s*var\(--text-secondary\)/
    );
    expect(fileIconRule).toMatch(
      /width:\s*var\(--agent-mention-file-icon-size,\s*16px\)/
    );
    expect(fileIconRule).toMatch(
      /height:\s*var\(--agent-mention-file-icon-size,\s*16px\)/
    );
    expect(fileIconRule).toMatch(
      /mask-size:\s*var\(--agent-mention-file-icon-size,\s*16px\)\s+var\(--agent-mention-file-icon-size,\s*16px\)/
    );
  });

  it("keeps conversation mention hover backgrounds outside the queue", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-conversation__assistant-markdown\s+\[data-agent-file-mention="true"\]\.tsh-agent-object-token,[\s\S]*?\.workspace-agents-status-panel__detail-user-message\s+\[data-agent-file-mention="true"\]\.tsh-agent-object-token\s*{[^}]*cursor:\s*pointer/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__assistant-markdown\s+\[data-agent-file-mention="true"\]\.tsh-agent-object-token,[\s\S]*?\.workspace-agents-status-panel__detail-user-message\s+\[data-agent-file-mention="true"\]\.tsh-agent-object-token\s*{[^}]*font-size:\s*13px/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__assistant-markdown\s+\[data-agent-file-mention="true"\]\.tsh-agent-object-token\s+\.tsh-agent-object-token__main,[\s\S]*?\.workspace-agents-status-panel__detail-user-message\s+\[data-agent-file-mention="true"\]\.tsh-agent-object-token\s+\.tsh-agent-object-token__main\s*{[^}]*font-size:\s*13px/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__assistant-markdown\s+\[data-agent-file-mention="true"\]\.tsh-agent-object-token:hover,[\s\S]*?\.workspace-agents-status-panel__detail-user-message\s+\[data-agent-file-mention="true"\]\.tsh-agent-object-token:hover\s*{[^}]*background:\s*color-mix\(in srgb,\s*currentColor 16%,\s*transparent\)/s
    );
  });

  it("keeps queued prompt text to one ellipsized line even when expanded", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");
    const queuedTextRule =
      css.match(
        /\.agent-gui-node__composer-queued-prompt-text\s*{[^}]*}/s
      )?.[0] ?? "";
    const expandedQueuedTextRule =
      css.match(
        /\.agent-gui-node__composer-queued-prompt-panel\[data-expanded="true"\]\s+\.agent-gui-node__composer-queued-prompt-text\s*{[^}]*}/s
      )?.[0] ?? "";

    expect(queuedTextRule).toMatch(/line-height:\s*28px/);
    expect(expandedQueuedTextRule).toMatch(/overflow:\s*hidden/);
    expect(expandedQueuedTextRule).toMatch(/text-overflow:\s*ellipsis/);
    expect(expandedQueuedTextRule).toMatch(/white-space:\s*nowrap/);
    expect(expandedQueuedTextRule).not.toMatch(/pre-wrap/);
  });

  it("keeps queued mention hover pills at the rich text mention height", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");
    const queuedEntityMentionRule =
      css.match(
        /\.agent-gui-node__composer-queued-prompt-markdown\s+\[data-agent-file-mention="true"\]\.tsh-agent-object-token--entity\s*{[^}]*}/s
      )?.[0] ?? "";
    const queuedEntityMentionHoverRule =
      css.match(
        /\.agent-gui-node__composer-queued-prompt-markdown\s+\[data-agent-file-mention="true"\]\.tsh-agent-object-token--entity:hover\s*{[^}]*}/s
      )?.[0] ?? "";

    expect(queuedEntityMentionRule).toMatch(/top:\s*3px/);
    expect(queuedEntityMentionRule).toMatch(/min-height:\s*24px/);
    expect(queuedEntityMentionRule).toMatch(/padding:\s*2px 4px/);
    expect(queuedEntityMentionRule).toMatch(/line-height:\s*20px/);
    expect(queuedEntityMentionHoverRule).toMatch(
      /color-mix\(in srgb,\s*var\(--text-primary\) 10%,\s*transparent\)/
    );
  });

  it("lets user message bubbles grow to fit mention content", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");
    const userBubbleRule =
      css.match(
        /\.workspace-agents-status-panel__detail-user-message\.agent-gui-conversation__user-message-bubble\s*{[^}]*}/s
      )?.[0] ?? "";
    const userTokenRule =
      css.match(
        /\.workspace-agents-status-panel__detail-user-message\s+\.tsh-agent-object-token\s*{[^}]*}/s
      )?.[0] ?? "";
    const userFileTokenRule =
      css.match(
        /\.workspace-agents-status-panel__detail-user-message\s+\.tsh-agent-object-token--file\s*{[^}]*}/s
      )?.[0] ?? "";
    const userFileMessageTokenRule =
      css.match(
        /\.workspace-agents-status-panel__detail-user-message\s+\[data-agent-file-mention="true"\]\[data-agent-mention-kind="file"\]\.tsh-agent-object-token--file\s*{[^}]*}/s
      )?.[0] ?? "";
    const userAppMessageTokenRule =
      css.match(
        /\.workspace-agents-status-panel__detail-user-message\s+\[data-agent-file-mention="true"\]\[data-agent-mention-kind="workspace-app"\]\.tsh-agent-object-token--entity\s*{[^}]*}/s
      )?.[0] ?? "";
    const userAppMessageTextRule =
      css.match(
        /\.workspace-agents-status-panel__detail-user-message\s+\[data-agent-file-mention="true"\]\[data-agent-mention-kind="workspace-app"\]\s+\.tsh-agent-object-token__main\s*{[^}]*}/s
      )?.[0] ?? "";
    const userEditorRule =
      css.match(
        /\.workspace-agents-status-panel__detail-user-message\s+>\s+div,[\s\S]*?\.workspace-agents-status-panel__detail-user-message\s+\.ProseMirror\s*{[^}]*}/s
      )?.[0] ?? "";

    expect(userBubbleRule).toMatch(/display:\s*inline-block/);
    expect(userBubbleRule).toMatch(/justify-self:\s*end/);
    expect(userBubbleRule).toMatch(/width:\s*fit-content/);
    expect(userBubbleRule).toMatch(/overflow:\s*visible/);
    expect(userBubbleRule).toMatch(/font-size:\s*13px/);
    expect(userBubbleRule).toMatch(/line-height:\s*24px/);
    expect(userTokenRule).toMatch(/font-size:\s*inherit/);
    expect(userTokenRule).not.toMatch(/line-height:\s*inherit/);
    expect(userTokenRule).toMatch(/overflow:\s*visible/);
    expect(userFileTokenRule).toMatch(/--agent-mention-file-icon-size:\s*16px/);
    expect(userFileTokenRule).not.toMatch(/min-height:\s*inherit/);
    expect(userFileTokenRule).not.toMatch(/line-height:\s*inherit/);
    expect(userFileMessageTokenRule).toMatch(/top:\s*-2px/);
    expect(userFileMessageTokenRule).toMatch(/line-height:\s*20px/);
    expect(userFileMessageTokenRule).toMatch(/vertical-align:\s*middle/);
    expect(userAppMessageTokenRule).toMatch(/top:\s*-2px/);
    expect(userAppMessageTokenRule).toMatch(/min-height:\s*24px/);
    expect(userAppMessageTokenRule).toMatch(/line-height:\s*24px/);
    expect(userAppMessageTokenRule).toMatch(/vertical-align:\s*middle/);
    expect(userAppMessageTextRule).toMatch(/overflow:\s*visible/);
    expect(userEditorRule).toMatch(/width:\s*fit-content/);
    expect(userEditorRule).toMatch(/max-width:\s*100%/);
    expect(userEditorRule).toMatch(/font-size:\s*inherit/);
    expect(userEditorRule).toMatch(/line-height:\s*inherit/);
  });
});
