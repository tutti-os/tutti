import {
  fireEvent,
  render,
  screen,
  act,
  waitFor,
  within
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import type { WorkspaceAgentSessionDetailViewModel } from "../../shared/workspaceAgentSessionDetailViewModel";
import type { AgentHostManagedAgentsState } from "../../shared/contracts/dto";
import type { WorkspaceFileReferenceAdapter } from "@tutti-os/workspace-file-reference/contracts";
import type {
  ReferenceNode,
  SelectedReference
} from "@tutti-os/workspace-file-reference/contracts";
import type { ReferenceSourceAggregator } from "@tutti-os/workspace-file-reference/core";
import type { WorkspaceLinkAction } from "../../actions/workspaceLinkActions";
import type { AgentActivitySnapshot } from "@tutti-os/agent-activity-core";
import { MANAGED_AGENT_ICON_URLS } from "../../shared/managedAgentIcons";
import { AgentActivityHostProvider } from "../../agentActivityHost";
import type { AgentActivityRuntime } from "../../agentActivityRuntime";
import { AgentGUINode } from "./AgentGUINode";
import { getAgentEnvPanelStore } from "../../shared/agentEnv/agentEnvPanelStore";
import { getWorkspaceSettingsPanelStore } from "../../shared/workspaceSettingsPanel/workspaceSettingsPanelStore";
import {
  resolveAgentGUIHeroIconUrl,
  shouldEmphasizeEmptyHeroProvider
} from "./AgentGUINodeView";
import type { AgentContextMentionProvider } from "./agentContextMentionProvider";
import { AGENT_CONTEXT_MENTION_PROVIDER_IDS } from "./agentContextMentionProvider";
import type {
  AgentComposerDraft,
  AgentGUIQueuedPromptVM,
  AgentGUINodeViewModel
} from "./model/agentGuiNodeTypes";
import type { AgentGUINodeData } from "../../types";
import { createLocalAgentGUIProviderTarget } from "../../providerTargets";
import { writeWorkspaceFileDropData } from "../terminalNode/workspaceFileDrop";

const mockCreateConversation = vi.fn();
const mockSelectConversation = vi.fn();
const mockSubmitPrompt = vi.fn();
const mockShowPromptImagesUnsupported = vi.fn();
const mockSubmitApprovalOption = vi.fn();
const mockSubmitInteractivePrompt = vi.fn();
const mockInterruptCurrentTurn = vi.fn();
const mockUpdateDraftContent = vi.fn();
const mockUpdateComposerSettings = vi.fn();
const mockSendQueuedPromptNext = vi.fn();
const mockRemoveQueuedPrompt = vi.fn();
const mockEditQueuedPrompt = vi.fn();
const mockRemoveProject = vi.fn();
const mockConfirmDeleteProjectConversations = vi.fn();
const mockRequestDeleteConversation = vi.fn();
const mockRetryActivation = vi.fn();
const mockContinueInNewConversation = vi.fn();
const mockRetryOpenclawGateway = vi.fn();
const mockCancelDeleteConversation = vi.fn();
const mockConfirmDeleteConversation = vi.fn();
const mockRenameConversation = vi.fn<() => Promise<void>>();
const mockSearchWorkspaceFileManagerEntries = vi.fn();
const mockListWorkspaceIssues = vi.fn();
const mockListWorkspaceApps = vi.fn();
const mockListWorkspaceAgents = vi.fn();
const mockListWorkspaceAgentSessionMessages = vi.fn();
const mockGetWorkspaceAgentSessionSummary = vi.fn();
const mockBatchGetUserInfo = vi.fn();

const {
  agentSession: AGENT_SESSION_PROVIDER_ID,
  file: FILE_PROVIDER_ID,
  workspaceApp: WORKSPACE_APP_PROVIDER_ID,
  workspaceIssue: WORKSPACE_ISSUE_PROVIDER_ID
} = AGENT_CONTEXT_MENTION_PROVIDER_IDS;
const mockSelectFiles = vi.fn();
const mockSelectDirectory = vi.fn();
const mockEnsureDirectory = vi.fn();
const mockWriteClipboardText = vi.fn();
const mockRegisterUploadSources = vi.fn();
const mockInspectUploadSources = vi.fn();
const mockPreflightUpload = vi.fn();
let mockViewModel: AgentGUINodeViewModel;

function createDraft(prompt: string): AgentComposerDraft {
  return { prompt, images: [], files: [] };
}

function createHostLocalReferenceAggregator(
  entry: ReferenceNode
): ReferenceSourceAggregator {
  return {
    async listSources() {
      return [
        {
          sourceId: "host-local-file",
          label: "本地文件",
          capabilities: {
            filterable: true,
            navigable: false,
            paginated: false,
            previewable: false,
            searchable: true
          }
        }
      ];
    },
    async listRoot() {
      return [];
    },
    async listChildren() {
      return { entries: [entry], nextCursor: null };
    },
    async search() {
      return { entries: [], nextCursor: null };
    },
    async open() {},
    async listOpenWithApplications() {
      return [];
    },
    async openWithApplication() {},
    async openWithOtherApplication() {},
    async reveal() {},
    async readPreview() {
      return null;
    },
    resolveSelection(node): SelectedReference {
      return {
        path: node.ref.nodeId,
        hostPath: node.ref.nodeId,
        kind: node.kind,
        displayName: node.displayName,
        sourceId: node.ref.sourceId
      };
    },
    async locateTarget() {
      return null;
    },
    getLoadedSource() {
      return undefined;
    }
  };
}

function textQueuedPrompt(
  id: string,
  text: string,
  createdAtUnixMs = 1
): AgentGUIQueuedPromptVM {
  return {
    id,
    content: [{ type: "text", text }],
    createdAtUnixMs
  };
}

function promptBlocks(text: string) {
  return [{ type: "text" as const, text }];
}

function getComposerEditor(): HTMLElement {
  return screen.getByRole("textbox", {
    name: /agentHost\.agentGui\.(initial|followup|installRequired|collaboratorSessionReadOnly)Placeholder/
  });
}

function queryComposerEditor(): HTMLElement | null {
  return screen.queryByRole("textbox", {
    name: /agentHost\.agentGui\.(initial|followup|installRequired|collaboratorSessionReadOnly)Placeholder/
  });
}

function pasteComposerText(text: string): void {
  fireEvent.paste(getComposerEditor(), {
    clipboardData: {
      getData: (type: string) => (type === "text/plain" ? text : "")
    }
  });
}

function createDataTransferStub(files: readonly File[] = []): DataTransfer {
  const store = new Map<string, string>();
  const dataTransfer = {
    effectAllowed: "none",
    dropEffect: "none",
    types: [] as string[],
    files,
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file
    })),
    setData(format: string, data: string) {
      store.set(format, data);
      dataTransfer.types = [...store.keys()];
    },
    getData(format: string) {
      return store.get(format) ?? "";
    }
  };
  return dataTransfer as unknown as DataTransfer;
}

function createAgentGUITestContextMentionProviders(): readonly AgentContextMentionProvider[] {
  return [
    {
      id: FILE_PROVIDER_ID,
      trigger: "@",
      async query({ context, keyword, maxResults }) {
        const workspaceId = String(context.metadata?.workspaceId ?? "");
        const result = await mockSearchWorkspaceFileManagerEntries({
          workspaceId,
          query: keyword,
          limit: maxResults,
          includeKinds: ["file", "directory"]
        });
        return (result.entries ?? []).map((entry: any) => ({
          href: entry.path,
          label: entry.name
        }));
      },
      getItemKey: (item: any) => item.href,
      getItemLabel: (item: any) => item.label,
      toInsertResult: (item: any) => ({
        kind: "markdown-link",
        label: item.label,
        href: item.href
      })
    },
    {
      id: WORKSPACE_ISSUE_PROVIDER_ID,
      trigger: "@",
      async query({ context, keyword, maxResults }) {
        const workspaceId = String(context.metadata?.workspaceId ?? "");
        const result = await mockListWorkspaceIssues({
          workspaceId,
          pageSize: maxResults,
          searchQuery: keyword
        });
        return result.issues ?? [];
      },
      getItemKey: (item: any) => item.issueId,
      getItemLabel: (item: any) => item.title,
      getItemSubtitle: (item: any) => extractAgentGUITestIssuePreview(item),
      toInsertResult: (item: any) => ({
        kind: "mention",
        mention: {
          entityId: item.issueId,
          label: item.title,
          scope: { workspaceId: item.workspaceId },
          presentation: {
            description: extractAgentGUITestIssuePreview(item),
            status: item.status
          }
        }
      })
    },
    {
      id: WORKSPACE_APP_PROVIDER_ID,
      trigger: "@",
      async query({ context, keyword, maxResults }) {
        const workspaceId = String(context.metadata?.workspaceId ?? "");
        const result = await mockListWorkspaceApps({
          workspaceId,
          query: keyword,
          limit: maxResults
        });
        return result.apps ?? [];
      },
      getItemKey: (item: any) => item.appId,
      getItemLabel: (item: any) => item.name,
      getItemSubtitle: (item: any) => item.description ?? "",
      toInsertResult: (item: any) => ({
        kind: "mention",
        mention: {
          entityId: item.appId,
          label: item.name,
          scope: { workspaceId: item.workspaceId },
          presentation: {
            description: item.description ?? "",
            iconUrl: item.iconUrl ?? ""
          }
        }
      })
    },
    {
      id: AGENT_SESSION_PROVIDER_ID,
      trigger: "@",
      async query({ context, keyword, maxResults }) {
        const workspaceId = String(context.metadata?.workspaceId ?? "");
        const currentUserId = String(context.metadata?.currentUserId ?? "");
        const snapshot = await mockListWorkspaceAgents({
          workspaceId: workspaceId,
          sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
        });
        const sessions = (snapshot.sessions ?? []).slice(0, maxResults);
        const userIds = [
          ...new Set(
            sessions
              .map((session: any) => String(session.userId ?? "").trim())
              .filter(Boolean)
          )
        ];
        const profilesResult =
          userIds.length > 0
            ? await mockBatchGetUserInfo({ userIds })
            : { users: [] };
        const profiles = new Map(
          (profilesResult.users ?? []).map((user: any) => [user.userId, user])
        );
        const items = await Promise.all(
          sessions.map(async (session: any) => {
            const summary = await Promise.resolve(
              mockGetWorkspaceAgentSessionSummary({
                workspaceId: workspaceId,
                agentSessionId: session.agentSessionId,
                agentReplyLimit: 1,
                recentTurnLimit: 1
              })
            ).catch(() => null);
            const userId = String(session.userId ?? "");
            const profile = profiles.get(userId) as any;
            const title =
              compactAgentGUITestText(session.title) ||
              compactAgentGUITestText(summary?.latestUserRequirement) ||
              compactAgentGUITestText(summary?.initialUserRequirement) ||
              (await resolveAgentGUITestSessionFallbackTitle({
                session,
                workspaceId
              })) ||
              session.agentSessionId;
            return {
              agentName: agentGUITestProviderLabel(session.provider),
              id: session.agentSessionId,
              initiatorAvatarUrl: profile?.avatar ?? "",
              initiatorName: profile?.name || userId,
              provider: session.provider,
              scope:
                userId && userId === currentUserId
                  ? "my_sessions"
                  : "collab_sessions",
              status: resolveAgentGUITestSessionStatus(summary, session),
              title,
              inputPreview:
                compactAgentGUITestText(summary?.latestUserRequirement) ||
                compactAgentGUITestText(summary?.initialUserRequirement),
              summaryPreview: compactAgentGUITestText(
                summary?.recentAgentReplies?.[0]
              ),
              updatedAtUnixMs:
                session.updatedAtUnixMs ?? session.createdAtUnixMs ?? 0,
              userId,
              workspaceId
            };
          })
        );
        const normalizedKeyword = keyword.trim().toLowerCase();
        return normalizedKeyword
          ? items.filter((item) =>
              [
                item.agentName,
                item.initiatorName,
                item.provider,
                item.title,
                item.inputPreview,
                item.summaryPreview
              ]
                .join("\n")
                .toLowerCase()
                .includes(normalizedKeyword)
            )
          : items;
      },
      getItemKey: (item: any) => item.id,
      getItemLabel: (item: any) => item.title,
      getItemSubtitle: (item: any) => item.inputPreview || item.status,
      toInsertResult: (item: any) => ({
        kind: "mention",
        mention: {
          entityId: item.id,
          label: item.title,
          scope: {
            scope: item.scope,
            userId: item.userId,
            workspaceId: item.workspaceId
          },
          presentation: {
            description: item.inputPreview || item.summaryPreview,
            status: item.status,
            subtitle: item.agentName
          }
        }
      })
    }
  ];
}

function extractAgentGUITestIssuePreview(item: any): string {
  try {
    const parsed = JSON.parse(String(item.content ?? ""));
    return collectAgentGUITestText(parsed)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return compactAgentGUITestText(item.content);
  }
}

function collectAgentGUITestText(node: any): string[] {
  if (!node || typeof node !== "object") {
    return [];
  }
  return [
    typeof node.text === "string" ? node.text : "",
    ...(Array.isArray(node.content)
      ? node.content.flatMap((child: any) => collectAgentGUITestText(child))
      : [])
  ].filter(Boolean);
}

function compactAgentGUITestText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function agentGUITestProviderLabel(provider: string): string {
  if (provider === "codex") {
    return "Codex";
  }
  if (provider === "nexight") {
    return "Nexight";
  }
  if (provider === "claude-code") {
    return "Claude Code";
  }
  return provider;
}

function resolveAgentGUITestSessionStatus(summary: any, session: any): string {
  const raw = String(
    (typeof summary?.executionStatus === "string"
      ? summary.executionStatus
      : summary?.executionStatus?.currentOrFinalStatus) ??
      summary?.currentOrFinalStatus ??
      session.lifecycleStatus ??
      session.effectiveStatus ??
      session.status ??
      "idle"
  ).toLowerCase();
  return raw === "running" ? "working" : raw;
}

async function resolveAgentGUITestSessionFallbackTitle({
  session,
  workspaceId
}: {
  session: any;
  workspaceId: string;
}): Promise<string> {
  const result = await mockListWorkspaceAgentSessionMessages({
    workspaceId: workspaceId,
    agentSessionId: session.agentSessionId,
    afterVersion: 0,
    limit: 20
  }).catch(() => null);
  const messages = result?.messages ?? [];
  const firstUserMessage = messages.find((message: any) => {
    return message.role === "user" || message.kind === "user";
  });
  return compactAgentGUITestText(
    firstUserMessage?.payload?.text ?? firstUserMessage?.body ?? ""
  );
}

vi.mock("../../i18n/index", () => ({
  getActiveUiLanguage: () => "zh-CN",
  translate: (key: string, options?: { count?: number }) => {
    if (key === "agentHost.agentGui.contextPickerExpandMore") {
      return `展开更多 ${options?.count ?? 0} 条`;
    }
    if (key === "agentHost.workspaceAgentActivityStatusWorking") {
      return "运行中";
    }
    if (key === "agentHost.workspaceAgentActivityStatusWaiting") {
      return "等待中";
    }
    if (key === "agentHost.workspaceAgentActivityStatusIdle") {
      return "已完成";
    }
    if (key === "agentHost.workspaceAgentActivityStatusEnd") {
      return "已完成";
    }
    if (key === "agentHost.workspaceAgentActivityStatusCompleted") {
      return "已完成";
    }
    if (key === "agentHost.workspaceAgentActivityStatusCanceled") {
      return "已取消";
    }
    if (key === "agentHost.workspaceAgentActivityStatusFailed") {
      return "错误";
    }
    const mentionLabels: Record<string, string> = {
      "agentHost.roomIssueNode.issueStatusNotStarted": "待开始",
      "agentHost.roomIssueNode.issueStatusRunning": "执行中",
      "agentHost.roomIssueNode.issueStatusPendingAcceptance": "待验收",
      "agentHost.roomIssueNode.issueStatusCompleted": "已完成",
      "agentHost.roomIssueNode.issueStatusFailed": "失败",
      "agentHost.roomIssueNode.issueStatusCanceled": "已取消",
      "agentHost.agentGui.mentionFilterApp": "App",
      "agentHost.agentGui.mentionFilterAgent": "Agent",
      "agentHost.agentGui.mentionFilterFile": "文件",
      "agentHost.agentGui.mentionFilterSession": "会话",
      "agentHost.agentGui.mentionFilterCollab": "协作",
      "agentHost.agentGui.mentionFilterIssue": "Tasks",
      "agentHost.agentGui.mentionGroupApps": "App",
      "agentHost.agentGui.mentionGroupAgents": "Agent",
      "agentHost.agentGui.mentionGroupFiles": "文件",
      "agentHost.agentGui.mentionGroupMySessions": "我的会话",
      "agentHost.agentGui.mentionGroupCollabSessions": "协作会话",
      "agentHost.agentGui.mentionGroupIssues": "Tasks",
      "agentHost.agentGui.mentionEmptyMySessions": "暂无会话",
      "agentHost.agentGui.mentionEmptyCollabSessions": "暂无协作会话",
      "agentHost.agentGui.mentionEmptyAgents": "No agents yet",
      "agentHost.agentGui.mentionEmptyIssues": "No tasks yet",
      "agentHost.agentGui.mentionNoMatchingFiles": "没有匹配到文件",
      "agentHost.agentGui.fileMentionEmpty": "根据你输入的内容搜索工作区文件",
      "agentHost.agentGui.promptTipsPrefix": "Tips：",
      "agentHost.agentGui.promptTips.setWorkspace.label": "指定工作区",
      "agentHost.agentGui.promptTips.setWorkspace.prompt":
        "让 Agent 知道在哪里读文件、运行命令和理解代码",
      "agentHost.agentGui.promptTips.useIssue.label": "善用任务",
      "agentHost.agentGui.promptTips.useIssue.prompt":
        "把需求、约束和验收标准写进任务，Agent 更容易按目标推进",
      "agentHost.agentGui.promptTips.mapCurrentState.label": "先梳理现状",
      "agentHost.agentGui.promptTips.mapCurrentState.prompt":
        "不确定怎么下手时，让 Agent 先总结当前状态、风险和下一步",
      "agentHost.agentGui.promptTips.continueRecentSession.label":
        "接力最近会话",
      "agentHost.agentGui.promptTips.continueRecentSession.prompt":
        "延续工作时让 Agent 先回顾最近进展、未完成任务和阻塞点",
      "agentHost.agentGui.promptTips.referenceOtherAgents.label":
        "引用其他 Agent 对话历史",
      "agentHost.agentGui.promptTips.referenceOtherAgents.prompt":
        "让上下文接力更完整，减少关键信息丢失",
      "agentHost.agentGui.promptTips.controlPermissions.label": "控制执行权限",
      "agentHost.agentGui.promptTips.controlPermissions.prompt":
        "需要稳妥时使用「请求批准」，确认可改文件后再切到更高权限",
      "agentHost.agentGui.approvalOptions.allowOnce": "Yes, proceed",
      "agentHost.agentGui.approvalOptions.allowAlways":
        "Yes, and don't ask again",
      "agentHost.agentGui.approvalOptions.rejectOnce": "No, don't run",
      "agentHost.agentGui.approvalOptions.rejectAlways":
        "No, and don't ask again",
      "agentHost.agentGui.approvalOptions.rejectWithFollowUp":
        "No, then send new instructions",
      "agentHost.agentGui.contextPickerBrowseFileHint":
        "根据你输入的内容搜索工作区文件",
      "agentHost.agentGui.contextPickerBrowseSessionHint":
        "输入内容以搜索我发起的 Agent 会话",
      "agentHost.agentGui.contextPickerBrowseAgentHint": "输入内容以搜索 Agent",
      "agentHost.agentGui.contextPickerBrowseAppHint": "输入内容以搜索应用",
      "agentHost.agentGui.contextPickerBrowseIssueHint":
        "输入内容以搜索当前房间内的 Issue",
      "agentHost.agentGui.fileMentionSwitchCategory": "切换分类",
      "agentHost.agentGui.fileMentionNavigateHierarchy": "进入/返回文件夹",
      "agentHost.agentGui.fileMentionSwitchSelection": "切换选中"
    };
    if (mentionLabels[key]) {
      return mentionLabels[key];
    }
    return key;
  },
  useTranslation: () => ({
    t: (
      key: string,
      options?: {
        count?: number;
        percent?: number;
        percentLeft?: number;
        reset?: string;
        text?: string;
        label?: string;
        provider?: string;
        usedTokens?: string;
        totalTokens?: string;
      }
    ) => {
      if (key === "agentHost.agentGui.empty") {
        return `What can ${options?.provider ?? "Codex"} help you with?`;
      }
      if (typeof options?.count === "number") {
        if (key === "agentHost.agentGui.relativeTimeMinutes") {
          return `${options.count} 分钟`;
        }
        if (key === "agentHost.agentGui.relativeTimeHours") {
          return `${options.count} 小时`;
        }
        if (key === "agentHost.agentGui.relativeTimeDays") {
          return `${options.count} 天`;
        }
        if (key === "agentHost.agentGui.relativeTimeMonths") {
          return `${options.count} 个月`;
        }
        if (key === "agentHost.agentGui.relativeTimeYears") {
          return `${options.count} 年`;
        }
      }
      if (key === "agentHost.agentGui.relativeTimeJustNow") {
        return "刚刚";
      }
      if (key === "agentHost.workspaceAgentProbeDockAvailable") {
        return "可用";
      }
      if (key === "agentHost.workspaceAgentProbeDetailStatus") {
        return "状态";
      }
      if (key === "agentHost.workspaceAgentProbeDetailQuota") {
        return "额度";
      }
      if (key === "agentHost.workspaceAgentProbeUsageUnsupported") {
        return "暂未接入用量";
      }
      if (key === "agentHost.workspaceAgentProbeQuotaRemaining") {
        return `剩余 ${options?.percent ?? 0}%`;
      }
      if (key === "agentHost.workspaceAgentProbeQuotaResetTimeLabel") {
        return `${options?.label ?? ""}重置时间`;
      }
      if (key === "messages.agentSettingsRequireNewSession") {
        return "This model can only be used in a new session to preserve context.";
      }
      if (key === "agentHost.agentGui.slashStatusContextValue") {
        return `${options?.percentLeft ?? 0}% left (${options?.usedTokens ?? ""} used / ${options?.totalTokens ?? ""})`;
      }
      if (key === "agentHost.agentGui.slashStatusLimitPercentLeft") {
        return `${options?.percent ?? 0}% left`;
      }
      if (key === "agentHost.agentGui.slashStatusLimitReset") {
        return `resets ${options?.reset ?? ""}`;
      }
      const agentGuiLabels: Record<string, string> = {
        "agentHost.agentGui.slashStatusTitle": "Status",
        "agentHost.agentGui.slashStatusSession": "Session",
        "agentHost.agentGui.slashStatusBaseUrl": "Base URL",
        "agentHost.agentGui.slashStatusContext": "Context",
        "agentHost.agentGui.slashStatusLimits": "Limits",
        "agentHost.agentGui.slashStatusClose": "Close",
        "agentHost.agentGui.slashStatusFiveHourLimit": "5h limit",
        "agentHost.agentGui.slashStatusWeeklyLimit": "7d limit",
        "agentHost.agentGui.slashStatusContextUnavailable":
          "Context usage unavailable",
        "agentHost.agentGui.slashStatusLimitsUnavailable":
          "Rate limits unavailable",
        "agentHost.agentGui.slashCommandCompactLabel": "compact",
        "agentHost.agentGui.slashCommandContextLabel": "context",
        "agentHost.agentGui.slashCommandFastLabel": "fast",
        "agentHost.agentGui.slashCommandGoalLabel": "goal",
        "agentHost.agentGui.slashCommandInitLabel": "init",
        "agentHost.agentGui.slashCommandPlanLabel": "plan",
        "agentHost.agentGui.slashCommandReviewLabel": "review",
        "agentHost.agentGui.slashCommandStatusLabel": "status",
        "agentHost.agentGui.slashCommandUsageLabel": "usage",
        "agentHost.agentGui.markSessionUnread": "Mark as unread",
        "agentHost.agentGui.collaboratorSessionReadOnlyPlaceholder":
          "非当前用户会话，不可直接对话",
        "agentHost.agentGui.promptTipsPrefix": "Tips：",
        "agentHost.agentGui.promptTips.setWorkspace.label": "指定工作区",
        "agentHost.agentGui.promptTips.setWorkspace.prompt":
          "让 Agent 知道在哪里读文件、运行命令和理解代码",
        "agentHost.agentGui.promptTips.useIssue.label": "善用任务",
        "agentHost.agentGui.promptTips.useIssue.prompt":
          "把需求、约束和验收标准写进任务，Agent 更容易按目标推进",
        "agentHost.agentGui.promptTips.mapCurrentState.label": "先梳理现状",
        "agentHost.agentGui.promptTips.mapCurrentState.prompt":
          "不确定怎么下手时，让 Agent 先总结当前状态、风险和下一步",
        "agentHost.agentGui.promptTips.continueRecentSession.label":
          "接力最近会话",
        "agentHost.agentGui.promptTips.continueRecentSession.prompt":
          "延续工作时让 Agent 先回顾最近进展、未完成任务和阻塞点",
        "agentHost.agentGui.promptTips.referenceOtherAgents.label":
          "引用其他 Agent 对话历史",
        "agentHost.agentGui.promptTips.referenceOtherAgents.prompt":
          "让上下文接力更完整，减少关键信息丢失",
        "agentHost.agentGui.promptTips.controlPermissions.label":
          "控制执行权限",
        "agentHost.agentGui.promptTips.controlPermissions.prompt":
          "需要稳妥时使用「请求批准」，确认可改文件后再切到更高权限"
      };
      if (agentGuiLabels[key]) {
        return agentGuiLabels[key];
      }
      return key;
    }
  }),
  translateInUiLanguage: (_language: string, key: string) => key
}));

vi.mock("./controller/useAgentGUINodeController", () => ({
  useAgentGUINodeController: () => ({
    viewModel: mockViewModel,
    actions: {
      createConversation: mockCreateConversation,
      selectConversation: mockSelectConversation,
      submitPrompt: mockSubmitPrompt,
      showPromptImagesUnsupported: mockShowPromptImagesUnsupported,
      submitApprovalOption: mockSubmitApprovalOption,
      submitInteractivePrompt: mockSubmitInteractivePrompt,
      interruptCurrentTurn: mockInterruptCurrentTurn,
      updateDraftContent: mockUpdateDraftContent,
      updateComposerSettings: mockUpdateComposerSettings,
      sendQueuedPromptNext: mockSendQueuedPromptNext,
      removeQueuedPrompt: mockRemoveQueuedPrompt,
      editQueuedPrompt: mockEditQueuedPrompt,
      removeProject: mockRemoveProject,
      confirmDeleteProjectConversations: mockConfirmDeleteProjectConversations,
      markConversationUnread: vi.fn(),
      requestDeleteConversation: mockRequestDeleteConversation,
      retryActivation: mockRetryActivation,
      continueInNewConversation: mockContinueInNewConversation,
      retryOpenclawGateway: mockRetryOpenclawGateway,
      cancelDeleteConversation: mockCancelDeleteConversation,
      confirmDeleteConversation: mockConfirmDeleteConversation,
      renameConversation: mockRenameConversation
    }
  })
}));

describe("AgentGUINode", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    mockViewModel = createViewModel();
    const agentEnvPanelStore = getAgentEnvPanelStore();
    agentEnvPanelStore.open = false;
    agentEnvPanelStore.provider = null;
    agentEnvPanelStore.focus = null;
    const workspaceSettingsPanelStore = getWorkspaceSettingsPanelStore();
    workspaceSettingsPanelStore.section = null;
    workspaceSettingsPanelStore.requestSequence = 0;
    mockCreateConversation.mockClear();
    mockSelectConversation.mockClear();
    mockSubmitPrompt.mockClear();
    mockShowPromptImagesUnsupported.mockClear();
    mockSubmitApprovalOption.mockClear();
    mockSubmitInteractivePrompt.mockClear();
    mockInterruptCurrentTurn.mockClear();
    mockUpdateDraftContent.mockClear();
    mockUpdateComposerSettings.mockClear();
    mockSendQueuedPromptNext.mockClear();
    mockRemoveQueuedPrompt.mockClear();
    mockEditQueuedPrompt.mockClear();
    mockRemoveProject.mockClear();
    mockConfirmDeleteProjectConversations.mockClear();
    mockRequestDeleteConversation.mockClear();
    mockRetryActivation.mockClear();
    mockContinueInNewConversation.mockClear();
    mockRetryOpenclawGateway.mockClear();
    mockCancelDeleteConversation.mockClear();
    mockConfirmDeleteConversation.mockClear();
    mockRenameConversation.mockClear();
    mockSearchWorkspaceFileManagerEntries.mockReset();
    mockListWorkspaceIssues.mockReset();
    mockListWorkspaceApps.mockReset();
    mockListWorkspaceAgents.mockReset();
    mockListWorkspaceAgentSessionMessages.mockReset();
    mockGetWorkspaceAgentSessionSummary.mockReset();
    mockBatchGetUserInfo.mockReset();
    mockSelectFiles.mockReset();
    mockSelectDirectory.mockReset();
    mockEnsureDirectory.mockReset();
    mockWriteClipboardText.mockReset();
    mockRegisterUploadSources.mockReset();
    mockInspectUploadSources.mockReset();
    mockPreflightUpload.mockReset();
    mockSearchWorkspaceFileManagerEntries.mockResolvedValue({
      workspaceId: "room-1",
      root: "/workspace",
      entries: []
    });
    mockListWorkspaceIssues.mockResolvedValue({
      issues: [],
      totalCount: 0,
      statusCounts: undefined
    });
    mockListWorkspaceApps.mockResolvedValue({
      apps: []
    });
    mockListWorkspaceAgents.mockResolvedValue({
      presences: [],
      sessions: []
    });
    mockListWorkspaceAgentSessionMessages.mockResolvedValue({
      messages: [],
      latestVersion: 0,
      hasMore: false
    });
    mockGetWorkspaceAgentSessionSummary.mockResolvedValue({
      workspaceId: "room-1",
      agentSessionId: "session-1",
      executionStatus: "COMPLETED",
      initialUserRequirement: "",
      latestUserRequirement: "",
      recentAgentReplies: [],
      initialTurn: null,
      latestTurn: null,
      recentTurns: []
    });
    mockBatchGetUserInfo.mockResolvedValue({ users: [] });
    mockEnsureDirectory.mockResolvedValue(undefined);
    mockWriteClipboardText.mockResolvedValue(undefined);
    mockInspectUploadSources.mockResolvedValue({
      hasGitignore: false,
      gitignoreSourceCount: 0
    });
    mockPreflightUpload.mockResolvedValue({ conflicts: [] });
    Object.defineProperty(window, "agentHostApi", {
      configurable: true,
      value: {
        account: {
          batchGetUserInfo: mockBatchGetUserInfo
        },
        clipboard: {
          writeText: mockWriteClipboardText
        },
        workspace: {
          selectFiles: mockSelectFiles,
          selectDirectory: mockSelectDirectory,
          ensureDirectory: mockEnsureDirectory
        },
        workspaceAgents: {
          list: mockListWorkspaceAgents,
          listSessionMessages: mockListWorkspaceAgentSessionMessages,
          getSessionSummary: mockGetWorkspaceAgentSessionSummary
        }
      }
    });
  });

  it("keeps the conversations section visible when there are no sessions", () => {
    renderAgentGUINode();

    const emptyState = screen
      .getByText("agentHost.agentGui.emptyProjectConversations")
      .closest("div");

    expect(
      screen.getByText("agentHost.agentGui.sectionConversations")
    ).toBeInTheDocument();
    expect(emptyState).toHaveClass(
      "agent-gui-node__conversation-section-empty"
    );
    expect(
      screen.queryByRole("button", {
        name: "agentHost.agentGui.startConversation"
      })
    ).toBeNull();
  });

  it("shows agent probe usage details in the title info entry", () => {
    const onAgentProbeDemandChange = vi.fn();

    renderAgentGUINode({
      workspaceAgentProbes: {
        isLoadingAvailability: false,
        isLoadingUsage: false,
        snapshot: {
          workspaceId: "workspace-1",
          capturedAtUnixMs: 1,
          providers: [
            {
              provider: "codex",
              availability: { status: "available", detailsVisible: false },
              usage: {
                capturedAtUnixMs: 1,
                quotas: [
                  {
                    quotaType: "session",
                    percentRemaining: 79,
                    resetText: "5月20日 21:31"
                  }
                ]
              }
            }
          ]
        }
      },
      onAgentProbeDemandChange
    });

    const info = screen.getByTestId("agent-gui-window-agent-info");
    expect(info).toHaveAttribute("aria-label", "可用，剩余 79%，5月20日 21:31");
    fireEvent.mouseEnter(info);
    expect(screen.getByText("状态")).toBeInTheDocument();
    expect(screen.getByText("可用")).toBeInTheDocument();
    expect(screen.getByText("额度")).toBeInTheDocument();
    expect(screen.getByText("额度重置时间")).toBeInTheDocument();
    expect(screen.getByText("剩余 79%")).toBeInTheDocument();
    expect(screen.getByText("5月20日 21:31")).toBeInTheDocument();
    expect(onAgentProbeDemandChange).toHaveBeenCalledWith(
      "codex",
      "agent-gui:agent-gui-1"
    );
  });

  it("shows a fallback when agent probe usage returns no quotas", () => {
    renderAgentGUINode({
      workspaceAgentProbes: {
        isLoadingAvailability: false,
        isLoadingUsage: false,
        snapshot: {
          workspaceId: "workspace-1",
          capturedAtUnixMs: 1,
          providers: [
            {
              provider: "codex",
              availability: { status: "available", detailsVisible: false },
              usage: {
                capturedAtUnixMs: 1,
                quotas: []
              }
            }
          ]
        }
      }
    });

    const info = screen.getByTestId("agent-gui-window-agent-info");
    expect(info).toHaveAttribute("aria-label", "可用，暂未接入用量");
    fireEvent.mouseEnter(info);
    expect(screen.getByText("状态")).toBeInTheDocument();
    expect(screen.getByText("可用")).toBeInTheDocument();
    expect(screen.getByText("额度")).toBeInTheDocument();
    expect(screen.getByText("暂未接入用量")).toBeInTheDocument();
  });

  it("shows the same fallback when an agent probe's usage fetch failed outright", () => {
    // A genuine fetch failure (no `usage` field, a `lastError` other than
    // "unsupported" — e.g. Claude Code credentials not yet readable right
    // after a fresh install) must not render as an empty, silent popover.
    renderAgentGUINode({
      workspaceAgentProbes: {
        isLoadingAvailability: false,
        isLoadingUsage: false,
        snapshot: {
          workspaceId: "workspace-1",
          capturedAtUnixMs: 1,
          providers: [
            {
              provider: "claude-code",
              availability: { status: "available", detailsVisible: false },
              lastError: { code: "auth_required", message: "not signed in" }
            }
          ]
        }
      },
      state: {
        provider: "claude-code",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      }
    });

    const info = screen.getByTestId("agent-gui-window-agent-info");
    fireEvent.mouseEnter(info);
    expect(screen.getByText("额度")).toBeInTheDocument();
    expect(screen.getByText("暂未接入用量")).toBeInTheDocument();
  });

  it("opens Agent settings directly for the unified All provider filter", () => {
    mockViewModel = createViewModel({
      conversationFilter: { kind: "all" },
      providerTargets: [
        createLocalAgentGUIProviderTarget("codex"),
        createLocalAgentGUIProviderTarget("claude-code")
      ]
    });

    renderAgentGUINode();

    fireEvent.click(screen.getByTitle("agentHost.agentGui.agentSettingsMenu"));

    expect(screen.queryByTestId("agent-gui-config-menu")).toBeNull();
    expect(getWorkspaceSettingsPanelStore()).toMatchObject({
      section: "agent",
      requestSequence: 1
    });
  });

  it("renders rail config usage from the unified provider filter target", async () => {
    const onAgentProbeDemandChange = vi.fn();
    const codexTarget = createLocalAgentGUIProviderTarget("codex");
    const claudeTarget = createLocalAgentGUIProviderTarget("claude-code");
    mockViewModel = createViewModel({
      conversationFilter: {
        kind: "agentTarget",
        agentTargetId: claudeTarget.agentTargetId ?? ""
      },
      selectedProviderTarget: codexTarget,
      providerTargets: [codexTarget, claudeTarget]
    });

    renderAgentGUINode({
      onAgentProbeDemandChange,
      workspaceAgentProbes: {
        isLoadingAvailability: false,
        isLoadingUsage: false,
        snapshot: {
          workspaceId: "workspace-1",
          capturedAtUnixMs: 1,
          providers: [
            {
              provider: "codex",
              availability: { status: "available", detailsVisible: false },
              usage: {
                capturedAtUnixMs: 1,
                quotas: [{ quotaType: "session", percentRemaining: 11 }]
              }
            },
            {
              provider: "claude-code",
              availability: { status: "available", detailsVisible: false },
              usage: {
                capturedAtUnixMs: 1,
                quotas: [{ quotaType: "session", percentRemaining: 42 }]
              }
            }
          ]
        }
      }
    });

    expect(onAgentProbeDemandChange).toHaveBeenCalledWith(
      "claude-code",
      "agent-gui:agent-gui-1:rail"
    );

    fireEvent.click(screen.getByTitle("agentHost.agentGui.agentConfig"));

    await waitFor(() => {
      expect(screen.getByText("42% left")).toBeInTheDocument();
    });
    expect(screen.queryByText("11% left")).toBeNull();
  });

  it("keeps the rail config limits section visible with a retry control when usage returns no quotas", async () => {
    // Regression: a Claude usage probe that comes back with an empty quota
    // list (no 5h/7d windows, or a fetch error the main-process probe caught
    // into lastError) previously made the entire "限制" section disappear from
    // the config menu with zero feedback. It must instead show an explicit
    // "unavailable" placeholder plus the refresh control so the user can retry.
    const onAgentProbeRefreshRequest = vi.fn();
    const claudeTarget = createLocalAgentGUIProviderTarget("claude-code");
    mockViewModel = createViewModel({
      conversationFilter: {
        kind: "agentTarget",
        agentTargetId: claudeTarget.agentTargetId ?? ""
      },
      selectedProviderTarget: claudeTarget,
      providerTargets: [claudeTarget]
    });

    renderAgentGUINode({
      onAgentProbeRefreshRequest,
      workspaceAgentProbes: {
        isLoadingAvailability: false,
        isLoadingUsage: false,
        snapshot: {
          workspaceId: "workspace-1",
          capturedAtUnixMs: 1,
          providers: [
            {
              provider: "claude-code",
              availability: { status: "available", detailsVisible: false },
              usage: { capturedAtUnixMs: 1, quotas: [] }
            }
          ]
        }
      }
    });

    fireEvent.click(screen.getByTitle("agentHost.agentGui.agentConfig"));

    await waitFor(() => {
      expect(
        screen.getByTestId("agent-gui-config-usage-unavailable")
      ).toBeInTheDocument();
    });
    const refresh = screen.getByTestId("agent-gui-config-usage-refresh");
    expect(refresh).toBeInTheDocument();

    fireEvent.click(refresh);
    expect(onAgentProbeRefreshRequest).toHaveBeenCalledWith(
      "claude-code",
      "agent-gui:agent-gui-1:usage-refresh"
    );
  });

  it("does not show the unavailable limits placeholder while usage is still loading", async () => {
    const claudeTarget = createLocalAgentGUIProviderTarget("claude-code");
    mockViewModel = createViewModel({
      conversationFilter: {
        kind: "agentTarget",
        agentTargetId: claudeTarget.agentTargetId ?? ""
      },
      selectedProviderTarget: claudeTarget,
      providerTargets: [claudeTarget]
    });

    renderAgentGUINode({
      workspaceAgentProbes: {
        isLoadingAvailability: false,
        isLoadingUsage: true,
        snapshot: {
          workspaceId: "workspace-1",
          capturedAtUnixMs: 1,
          providers: [
            {
              provider: "claude-code",
              availability: { status: "available", detailsVisible: false },
              usage: { capturedAtUnixMs: 1, quotas: [] }
            }
          ]
        }
      }
    });

    fireEvent.click(screen.getByTitle("agentHost.agentGui.agentConfig"));

    await waitFor(() => {
      expect(
        screen.getByTestId("agent-gui-config-usage-refresh")
      ).toHaveAttribute("data-state", "loading");
    });
    expect(
      screen.queryByTestId("agent-gui-config-usage-unavailable")
    ).toBeNull();
  });

  it("requests a fresh agent probe when the title info entry opens", () => {
    const onAgentProbeRefreshRequest = vi.fn();

    renderAgentGUINode({
      workspaceAgentProbes: {
        isLoadingAvailability: false,
        isLoadingUsage: false,
        snapshot: {
          workspaceId: "workspace-1",
          capturedAtUnixMs: 1,
          providers: [
            {
              provider: "codex",
              availability: { status: "available", detailsVisible: false },
              usage: {
                capturedAtUnixMs: 1,
                quotas: [{ quotaType: "session", percentRemaining: 79 }]
              }
            }
          ]
        }
      },
      agentActivityRuntime: {} as AgentActivityRuntime,
      onAgentProbeRefreshRequest
    });

    fireEvent.mouseEnter(screen.getByTestId("agent-gui-window-agent-info"));

    expect(onAgentProbeRefreshRequest).toHaveBeenCalledWith(
      "codex",
      "agent-gui:agent-gui-1"
    );
  });

  it("requests a fresh agent probe when the rail config menu opens", () => {
    const onAgentProbeRefreshRequest = vi.fn();
    const codexTarget = createLocalAgentGUIProviderTarget("codex");
    mockViewModel = createViewModel({
      conversationFilter: {
        kind: "agentTarget",
        agentTargetId: codexTarget.agentTargetId ?? ""
      },
      selectedProviderTarget: codexTarget,
      providerTargets: [codexTarget]
    });

    renderAgentGUINode({
      workspaceAgentProbes: {
        isLoadingAvailability: false,
        isLoadingUsage: false,
        snapshot: {
          workspaceId: "workspace-1",
          capturedAtUnixMs: 1,
          providers: [
            {
              provider: "codex",
              availability: { status: "available", detailsVisible: false },
              usage: {
                capturedAtUnixMs: 1,
                quotas: [{ quotaType: "session", percentRemaining: 79 }]
              }
            }
          ]
        }
      },
      agentActivityRuntime: {} as AgentActivityRuntime,
      onAgentProbeRefreshRequest
    });

    // This is the click-triggered "usage & environment check" rail menu, a
    // second surface showing the same probe data as the hover-triggered
    // title info tooltip above. It needs the same on-open refresh — a
    // provider that just finished installing must not stay stuck showing a
    // stale/empty probe fetched before install completed.
    fireEvent.click(screen.getByTitle("agentHost.agentGui.agentConfig"));

    expect(onAgentProbeRefreshRequest).toHaveBeenCalledWith(
      "codex",
      "agent-gui:agent-gui-1:config"
    );
  });

  it("updates slash status limits when the selected Codex model changes", () => {
    const workspaceAgentProbes: React.ComponentProps<
      typeof AgentGUINode
    >["workspaceAgentProbes"] = {
      isLoadingAvailability: false,
      isLoadingUsage: false,
      snapshot: {
        workspaceId: "room-1",
        capturedAtUnixMs: 1,
        providers: [
          {
            provider: "codex",
            availability: { status: "available", detailsVisible: false },
            usage: {
              capturedAtUnixMs: 1,
              quotas: [
                {
                  quotaType: "session",
                  percentRemaining: 91,
                  resetText: "5h reset"
                },
                {
                  quotaType: "weekly",
                  percentRemaining: 93,
                  resetText: "weekly reset"
                },
                {
                  quotaType: "model",
                  modelName: "GPT-5.3-Codex-Spark",
                  percentRemaining: 100,
                  resetText: "spark reset"
                }
              ]
            }
          }
        ]
      }
    };
    const renderNode = () => (
      <AgentGUINode
        nodeId="agent-gui-1"
        workspaceId="room-1"
        currentUserId="user-1"
        workspacePath="/workspace"
        workspaceFileReferenceAdapter={createWorkspaceFileReferenceAdapter()}
        agentSettings={{ avoidGroupingEdits: false }}
        title="Codex"
        state={{
          provider: "codex",
          lastActiveAgentSessionId: null,
          conversationRailWidthPx: null
        }}
        position={{ x: 0, y: 0 }}
        width={720}
        height={560}
        desktopSize={{ width: 1200, height: 800 }}
        onClose={vi.fn()}
        onResize={vi.fn()}
        onUpdateNode={vi.fn()}
        onShowMessage={vi.fn()}
        workspaceAgentProbes={workspaceAgentProbes}
        managedAgentsState={createManagedAgentsState()}
        contextMentionProviders={createAgentGUITestContextMentionProviders()}
        isActive
      />
    );
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/status",
      sessionChrome: {
        auth: null,
        approval: null,
        recovery: null,
        rawState: {
          workspaceId: "room-1",
          agentSessionId: "session-1",
          provider: "codex",
          status: "ready",
          updatedAtUnixMs: 1,
          runtimeContext: {
            usage: {
              contextWindow: {
                usedTokens: 1000,
                totalTokens: 2000
              }
            }
          }
        }
      }
    });

    const { container, rerender } = render(renderNode());
    fireEvent.submit(container.querySelector("form")!);

    const panel = screen.getByTestId("agent-gui-slash-status-panel");
    expect(panel).toHaveTextContent("5h limit");
    expect(panel).toHaveTextContent("91% left");
    expect(panel).toHaveTextContent("7d limit");
    expect(panel).toHaveTextContent("93% left");
    expect(panel).not.toHaveTextContent("GPT-5.3-Codex-Spark");
    expect(
      panel.querySelectorAll(".agent-gui-node__slash-status-limit-meter")
    ).toHaveLength(2);

    mockViewModel = createViewModel({
      ...mockViewModel,
      composerSettings: {
        ...mockViewModel.composerSettings,
        draftSettings: {
          ...mockViewModel.composerSettings.draftSettings,
          model: "gpt-5.3-codex-spark"
        },
        selectedModelValue: "gpt-5.3-codex-spark"
      }
    });
    rerender(renderNode());

    expect(panel).toHaveTextContent("GPT-5.3-Codex-Spark");
    expect(panel).toHaveTextContent("100% left");
    expect(panel).toHaveTextContent("5h limit");
    expect(panel).toHaveTextContent("7d limit");
    expect(
      panel.querySelectorAll(".agent-gui-node__slash-status-limit-meter")
    ).toHaveLength(3);
  });

  it("shows Claude Code slash status limits from ACP runtime usage", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/status",
      sessionChrome: {
        auth: null,
        approval: null,
        recovery: null,
        rawState: {
          workspaceId: "room-1",
          agentSessionId: "session-1",
          provider: "claude-code",
          status: "ready",
          updatedAtUnixMs: 1,
          runtimeContext: {
            providerConfig: {
              baseUrl: "https://anthropic.proxy.test"
            },
            usage: {
              contextWindow: {
                usedTokens: 50_000,
                totalTokens: 200_000
              },
              quotas: [
                {
                  quotaType: "session",
                  percentRemaining: 79,
                  resetText: "5h reset"
                },
                {
                  quotaType: "weekly",
                  percentRemaining: 91,
                  resetText: "weekly reset"
                }
              ]
            }
          }
        }
      }
    });

    const { container } = renderAgentGUINode({
      title: "Claude Code",
      state: {
        provider: "claude-code",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      }
    });
    fireEvent.submit(container.querySelector("form")!);

    const panel = screen.getByTestId("agent-gui-slash-status-panel");
    expect(panel).toHaveTextContent("75% left (50,000 used / 200,000)");
    expect(panel).toHaveTextContent("Base URL");
    expect(panel).toHaveTextContent("https://anthropic.proxy.test");
    expect(panel).toHaveTextContent("5h limit");
    expect(panel).toHaveTextContent("79% left");
    expect(panel).toHaveTextContent("7d limit");
    expect(panel).toHaveTextContent("91% left");
    expect(panel).not.toHaveTextContent("Rate limits unavailable");
  });

  it("offers only clear on the goal banner — no objective editing", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      sessionChrome: {
        auth: null,
        approval: null,
        recovery: null,
        rawState: {
          workspaceId: "room-1",
          agentSessionId: "session-1",
          provider: "claude-code",
          status: "working",
          updatedAtUnixMs: 1,
          runtimeContext: {
            goal: {
              objective: "帮我赚一个亿",
              status: "active"
            }
          }
        }
      }
    });

    renderAgentGUINode({
      title: "Claude Code",
      state: {
        provider: "claude-code",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      }
    });

    const banner = screen.getByTestId("agent-gui-goal-banner");
    expect(banner).toHaveTextContent("帮我赚一个亿");
    expect(
      screen.getByTestId("agent-gui-goal-banner-clear")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-gui-goal-banner-edit")
    ).not.toBeInTheDocument();
  });

  it("uses the generic Agent label as the Agent GUI window title", () => {
    const { container } = renderAgentGUINode({
      title: "Agent",
      state: {
        provider: "codex",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      }
    });

    const windowTitle = container.querySelector(
      '[data-workspace-node-window-title="true"]'
    );
    const windowRoot = container.querySelector<HTMLElement>(
      '[data-workspace-node-window-root="true"]'
    );

    expect(windowTitle).toHaveTextContent("Agent");
    expect(windowTitle).toHaveClass("max-w-[280px]");
    expect(windowTitle).toHaveClass("gap-2");
    expect(windowRoot?.style.getPropertyValue("--node-header-padding-x")).toBe(
      "16px"
    );
  });

  it("does not show a provider icon before the Agent GUI window title", () => {
    const codex = renderAgentGUINode({
      title: "Agent",
      state: {
        provider: "codex",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      }
    });

    const codexIcon = codex.container.querySelector<HTMLImageElement>(
      '[data-agent-gui-window-provider-icon="true"]'
    );
    expect(codexIcon).toBeNull();
    codex.unmount();

    const claude = renderAgentGUINode({
      title: "Agent",
      state: {
        provider: "claude-code",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      }
    });

    const claudeIcon = claude.container.querySelector<HTMLImageElement>(
      '[data-agent-gui-window-provider-icon="true"]'
    );
    expect(claudeIcon).toBeNull();
  });

  it("keeps the Agent window title when the rail is collapsed", () => {
    mockViewModel = createViewModel({
      activeConversation: {
        id: "session-1",
        provider: "codex",
        title: "Fresh dock title",
        status: "ready",
        cwd: "/workspace",
        updatedAtUnixMs: 1
      },
      activeConversationId: "session-1"
    });

    const { container } = renderAgentGUINode({
      title: "Agent",
      state: {
        provider: "codex",
        lastActiveAgentSessionId: "session-1",
        lastActiveConversationTitle: "Fresh dock title",
        conversationRailWidthPx: null,
        conversationRailCollapsed: true
      }
    });

    const windowTitle = container.querySelector(
      '[data-workspace-node-window-title="true"]'
    );
    expect(windowTitle).toHaveTextContent("Agent");
    expect(
      container.querySelector(".agent-gui-node__detail-header")
    ).toBeNull();
  });

  it("does not promote a fallback active conversation title into the window title when the rail is collapsed", () => {
    mockViewModel = createViewModel({
      activeConversation: {
        id: "session-1",
        provider: "codex",
        title: "Current task",
        status: "ready",
        cwd: "/workspace",
        updatedAtUnixMs: 1
      },
      activeConversationId: "session-1"
    });

    const { container } = renderAgentGUINode({
      title: "Agent",
      state: {
        provider: "codex",
        lastActiveAgentSessionId: "session-1",
        lastActiveConversationTitle: null,
        conversationRailWidthPx: null,
        conversationRailCollapsed: true
      }
    });

    expect(
      container.querySelector('[data-workspace-node-window-title="true"]')
    ).toHaveTextContent("Agent");
  });

  it("does not clear the dock conversation title while the active conversation is unavailable", () => {
    const onUpdateNode =
      vi.fn<
        (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
      >();
    mockViewModel = createViewModel({
      activeConversation: null,
      activeConversationId: "session-1"
    });

    renderAgentGUINode({
      onUpdateNode,
      state: {
        provider: "codex",
        lastActiveAgentSessionId: "session-1",
        lastActiveConversationTitle: "Existing dock title",
        conversationRailWidthPx: null
      }
    });

    expect(onUpdateNode).not.toHaveBeenCalled();
  });

  it("does not clear the dock conversation title while the active conversation title is hydrating", () => {
    const onUpdateNode =
      vi.fn<
        (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
      >();
    mockViewModel = createViewModel({
      activeConversation: {
        id: "session-1",
        provider: "codex",
        title: "",
        status: "ready",
        cwd: "/workspace",
        updatedAtUnixMs: 1
      },
      activeConversationId: "session-1"
    });

    renderAgentGUINode({
      onUpdateNode,
      state: {
        provider: "codex",
        lastActiveAgentSessionId: "session-1",
        lastActiveConversationTitle: "Existing dock title",
        conversationRailWidthPx: null
      }
    });

    expect(onUpdateNode).not.toHaveBeenCalled();
  });

  it("syncs the dock conversation title when the active conversation has a title", () => {
    const onUpdateNode =
      vi.fn<
        (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
      >();
    const state: AgentGUINodeData = {
      provider: "codex",
      lastActiveAgentSessionId: "session-1",
      lastActiveConversationTitle: "Existing dock title",
      conversationRailWidthPx: null
    };
    mockViewModel = createViewModel({
      activeConversation: {
        id: "session-1",
        provider: "codex",
        title: "Fresh dock title",
        status: "ready",
        cwd: "/workspace",
        updatedAtUnixMs: 1
      },
      activeConversationId: "session-1"
    });

    renderAgentGUINode({ onUpdateNode, state });

    expect(onUpdateNode).toHaveBeenCalledTimes(1);
    expect(onUpdateNode.mock.calls[0]?.[0](state)).toEqual({
      ...state,
      lastActiveConversationTitle: "Fresh dock title"
    });
  });

  it("does not sync the dock conversation title in preview mode", () => {
    const onUpdateNode =
      vi.fn<
        (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
      >();
    mockViewModel = createViewModel({
      activeConversation: {
        id: "session-1",
        provider: "codex",
        title: "Fresh dock title",
        status: "ready",
        cwd: "/workspace",
        updatedAtUnixMs: 1
      },
      activeConversationId: "session-1"
    });

    renderAgentGUINode({
      onUpdateNode,
      previewMode: true,
      state: {
        provider: "codex",
        lastActiveAgentSessionId: "session-1",
        lastActiveConversationTitle: null,
        conversationRailWidthPx: null
      }
    });

    expect(onUpdateNode).not.toHaveBeenCalled();
  });

  it("does not repeatedly sync the dock conversation title after parent state updates", () => {
    const onUpdateNode =
      vi.fn<
        (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
      >();
    const initialState: AgentGUINodeData = {
      provider: "codex",
      lastActiveAgentSessionId: "session-1",
      lastActiveConversationTitle: "Existing dock title",
      conversationRailWidthPx: null
    };
    mockViewModel = createViewModel({
      activeConversation: {
        id: "session-1",
        provider: "codex",
        title: "Fresh dock title",
        status: "ready",
        cwd: "/workspace",
        updatedAtUnixMs: 1
      },
      activeConversationId: "session-1"
    });

    const rendered = renderAgentGUINode({ onUpdateNode, state: initialState });
    const nextState = onUpdateNode.mock.calls[0]?.[0](initialState);
    expect(nextState).toEqual({
      ...initialState,
      lastActiveConversationTitle: "Fresh dock title"
    });
    onUpdateNode.mockClear();

    rendered.rerender(
      <AgentGUINode
        nodeId="agent-gui-1"
        workspaceId="room-1"
        currentUserId="user-1"
        workspacePath="/workspace"
        workspaceFileReferenceAdapter={createWorkspaceFileReferenceAdapter()}
        agentSettings={{ avoidGroupingEdits: false }}
        title="Codex"
        state={nextState as AgentGUINodeData}
        position={{ x: 0, y: 0 }}
        width={720}
        height={560}
        desktopSize={{ width: 1200, height: 800 }}
        onClose={vi.fn()}
        onResize={vi.fn()}
        onUpdateNode={onUpdateNode}
        onShowMessage={vi.fn()}
        managedAgentsState={createManagedAgentsState()}
        contextMentionProviders={createAgentGUITestContextMentionProviders()}
        isActive
      />
    );

    expect(onUpdateNode).not.toHaveBeenCalled();
  });

  it("unregisters agent probe demand when the Agent GUI closes", () => {
    const onAgentProbeDemandChange = vi.fn();

    const { unmount } = renderAgentGUINode({ onAgentProbeDemandChange });
    unmount();

    expect(onAgentProbeDemandChange).toHaveBeenCalledWith(
      "codex",
      "agent-gui:agent-gui-1"
    );
    expect(onAgentProbeDemandChange).toHaveBeenCalledWith(
      null,
      "agent-gui:agent-gui-1"
    );
  });

  it("registers probe demand for the active conversation provider", () => {
    const onAgentProbeDemandChange = vi.fn();
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      activeConversation: {
        id: "session-1",
        provider: "hermes",
        title: "Session 1",
        status: "ready",
        cwd: "/workspace",
        updatedAtUnixMs: 1
      }
    });

    renderAgentGUINode({
      state: {
        provider: "codex",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      onAgentProbeDemandChange
    });

    expect(onAgentProbeDemandChange).toHaveBeenCalledWith(
      "hermes",
      "agent-gui:agent-gui-1"
    );
  });

  it("mounts the composer safely in StrictMode", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: ""
    });

    renderAgentGUINode({ strictMode: true });

    expect(getComposerEditor()).toBeTruthy();
  });

  it("hides OpenClaw gateway startup while disabling new sessions until ready", () => {
    mockViewModel = createViewModel({
      data: {
        provider: "openclaw",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      openclawGateway: { status: "starting", error: null }
    });

    renderAgentGUINode({ workbenchWindowZIndex: 41 });

    expect(
      screen.queryByText("agentHost.agentGui.openclawGatewayStarting")
    ).toBeNull();
    const newConversationButton = getChromeNewConversationButton();
    fireEvent.click(newConversationButton);

    expect(
      screen.queryByRole("button", {
        name: "agentHost.agentGui.startConversation"
      })
    ).toBeNull();
    expect(newConversationButton).toBeDisabled();
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  it("lets the header new-conversation button receive clicks inside the node window", () => {
    renderAgentGUINode();

    fireEvent.click(getChromeNewConversationButton());

    expect(mockCreateConversation).toHaveBeenCalledTimes(1);
    expect(mockCreateConversation).toHaveBeenCalledWith({
      source: "rail_toolbar"
    });
  });

  it("clears stale active conversation chrome state before creating a new conversation", () => {
    const state: AgentGUINodeData = {
      provider: "codex",
      lastActiveAgentSessionId: "session-1",
      lastActiveConversationTitle: "Existing session",
      conversationRailWidthPx: null
    };
    const onUpdateNode =
      vi.fn<
        (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
      >();
    renderAgentGUINode({ onUpdateNode, state });

    fireEvent.click(getChromeNewConversationButton());

    expect(mockCreateConversation).toHaveBeenCalledTimes(1);
    expect(onUpdateNode).toHaveBeenCalledTimes(1);
    expect(onUpdateNode.mock.calls[0]?.[0](state)).toEqual({
      ...state,
      lastActiveAgentSessionId: null,
      lastActiveConversationTitle: null
    });
  });
  it("renders the Agent GUI window header controls without a maximize button", () => {
    renderAgentGUINode({
      onMinimize: vi.fn(),
      onToggleMaximize: vi.fn()
    });

    expect(
      screen.getByRole("button", { name: "common.minimize" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "agentHost.agentGui.collapseConversationRail"
      })
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "common.maximize" })
    ).toBeNull();
    expect(screen.getByRole("button", { name: "common.close" })).toBeTruthy();
  });

  it("toggles the conversation rail from the window header", () => {
    const onUpdateNode =
      vi.fn<
        (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
      >();
    const state: AgentGUINodeData = {
      provider: "codex",
      lastActiveAgentSessionId: null,
      conversationRailWidthPx: 360,
      conversationRailCollapsed: false
    };

    renderAgentGUINode({ state, onUpdateNode });

    const toggle = screen.getByRole("button", {
      name: "agentHost.agentGui.collapseConversationRail"
    });
    expect(toggle).toHaveAttribute(
      "data-agent-gui-conversation-rail-collapsed",
      "false"
    );
    fireEvent.click(toggle);

    expect(onUpdateNode).toHaveBeenCalledTimes(1);
    expect(onUpdateNode.mock.calls[0]?.[0](state)).toEqual({
      ...state,
      conversationRailCollapsed: true
    });
  });

  it("expands the agent window when opening an auto-collapsed conversation rail", () => {
    const onUpdateNode =
      vi.fn<
        (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
      >();
    const onResize = vi.fn();
    const state: AgentGUINodeData = {
      provider: "codex",
      lastActiveAgentSessionId: null,
      conversationRailWidthPx: 360,
      conversationRailCollapsed: false
    };

    renderAgentGUINode({ state, width: 460, onResize, onUpdateNode });

    const toggle = screen.getByRole("button", {
      name: "agentHost.agentGui.expandConversationRail"
    });
    expect(toggle).toHaveAttribute(
      "data-agent-gui-conversation-rail-collapsed",
      "true"
    );
    expect(toggle).toHaveAttribute(
      "data-agent-gui-conversation-rail-auto-collapsed",
      "true"
    );
    expect(toggle).toBeEnabled();

    fireEvent.click(toggle);

    expect(onResize).toHaveBeenCalledWith({
      position: { x: 0, y: 0 },
      size: { width: 800, height: 560 }
    });
    expect(onUpdateNode).toHaveBeenCalledTimes(1);
    expect(onUpdateNode.mock.calls[0]?.[0](state)).toBe(state);
  });

  it("clears manual rail collapse while expanding a too-narrow agent window", () => {
    const onUpdateNode =
      vi.fn<
        (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
      >();
    const onResize = vi.fn();
    const state: AgentGUINodeData = {
      provider: "codex",
      lastActiveAgentSessionId: null,
      conversationRailWidthPx: 360,
      conversationRailCollapsed: true
    };

    renderAgentGUINode({ state, width: 460, onResize, onUpdateNode });

    fireEvent.click(
      screen.getByRole("button", {
        name: "agentHost.agentGui.expandConversationRail"
      })
    );

    expect(onResize).toHaveBeenCalledWith({
      position: { x: 0, y: 0 },
      size: { width: 800, height: 560 }
    });
    expect(onUpdateNode.mock.calls[0]?.[0](state)).toEqual({
      ...state,
      conversationRailCollapsed: false
    });
  });
  it("renders the composer before a conversation is active", () => {
    renderAgentGUINode();

    const emptyHeading = screen.getByRole("heading", {
      name: "What can Codex help you with?"
    });
    const iconEffect = document.querySelector(
      ".agent-gui-node__empty-hero-icon-effect"
    );
    const launchpadIcon = document.querySelector(
      ".agent-gui-node__empty-hero-launchpad-icon .agent-gui-node__provider-rail-launchpad-icon"
    );

    expect(queryComposerEditor()).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "agentHost.agentGui.send" })
    ).toBeTruthy();
    expect(screen.queryByTestId("agent-gui-bottom-dock")).toBeNull();
    expect(emptyHeading).toBeTruthy();
    expect(iconEffect).toBeNull();
    expect(launchpadIcon).not.toBeNull();
    expect(
      launchpadIcon?.querySelectorAll(
        ".agent-gui-node__provider-rail-launchpad-item"
      )
    ).toHaveLength(7);
    expect(
      document.querySelector(".agent-gui-node__timeline-centered")
    ).toContainElement(emptyHeading);
  });

  it("renders the empty hero from the selected provider target", () => {
    const claudeTarget = createLocalAgentGUIProviderTarget("claude-code");
    mockViewModel = createViewModel({
      data: {
        provider: "codex",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      conversationFilter: {
        kind: "agentTarget",
        agentTargetId: claudeTarget.agentTargetId ?? ""
      },
      selectedProviderTarget: claudeTarget,
      providerTargets: [
        createLocalAgentGUIProviderTarget("codex"),
        claudeTarget
      ]
    });

    renderAgentGUINode();

    const emptyHeading = screen.getByRole("heading", {
      name: "What can Claude Code help you with?"
    });
    expect(
      within(emptyHeading).getByRole("combobox", {
        name: "agentHost.agentGui.providerSwitchLabel"
      })
    ).toHaveValue(claudeTarget.targetId);
    const iconEffect = document.querySelector(
      ".agent-gui-node__empty-hero-icon-effect"
    );
    expect(iconEffect).toHaveAttribute(
      "src",
      MANAGED_AGENT_ICON_URLS["claude-code"]
    );
  });

  it("resolves provider-specific hero icon artwork", () => {
    expect(resolveAgentGUIHeroIconUrl("codex")).toBe(
      MANAGED_AGENT_ICON_URLS.codex
    );
    expect(resolveAgentGUIHeroIconUrl("codex")).not.toContain("undefined");
    expect(resolveAgentGUIHeroIconUrl("codex")).not.toContain(
      "/node_modules/.vite/deps/"
    );
    expect(resolveAgentGUIHeroIconUrl("claude")).toBe(
      MANAGED_AGENT_ICON_URLS["claude-code"]
    );
    expect(resolveAgentGUIHeroIconUrl("hermes")).toBe(
      MANAGED_AGENT_ICON_URLS.hermes
    );
  });

  it("emphasizes the empty hero provider name across localized copy", () => {
    expect(
      shouldEmphasizeEmptyHeroProvider("What can Codex help you with?")
    ).toBe(true);
    expect(shouldEmphasizeEmptyHeroProvider("需要 Codex 帮你做些什么？")).toBe(
      true
    );
  });

  it("renders prompt tips in the new-session hero composer", () => {
    renderAgentGUINode();

    const tips = screen.getByTestId("agent-gui-prompt-tips");

    expect(within(tips).queryByRole("button")).toBeNull();
    expect(tips).toHaveTextContent(
      "Tips：指定工作区 · 让 Agent 知道在哪里读文件、运行命令和理解代码"
    );
  });

  it("hides prompt tips after a conversation is active", () => {
    const conversation = {
      id: "session-1",
      provider: "codex" as const,
      title: "Session 1",
      status: "ready" as const,
      cwd: "/workspace",
      updatedAtUnixMs: 1
    };
    mockViewModel = createViewModel({
      conversations: [conversation],
      activeConversation: conversation,
      activeConversationId: "session-1"
    });

    renderAgentGUINode();

    expect(screen.queryByTestId("agent-gui-prompt-tips")).toBeNull();
  });

  it("centers the unavailable chat empty state with the unavailable icon", () => {
    const conversation = {
      id: "session-1",
      provider: "codex" as const,
      title: "Session 1",
      status: "ready" as const,
      cwd: "/workspace",
      updatedAtUnixMs: 1
    };
    mockViewModel = createViewModel({
      conversations: [conversation],
      activeConversation: conversation,
      activeConversationId: "session-1"
    });

    renderAgentGUINode();

    const emptyState = screen.getByTestId("agent-gui-unavailable-chat-empty");
    const timeline = screen.getByTestId("agent-gui-timeline");

    expect(timeline).toHaveClass(
      "agent-gui-node__timeline-unavailable-chat-empty"
    );
    expect(emptyState).toHaveClass("agent-gui-node__unavailable-chat-empty");
    expect(emptyState.querySelector("svg")).toHaveClass(
      "agent-gui-node__unavailable-chat-empty-icon"
    );
    expect(emptyState).toHaveTextContent(
      "agentHost.agentGui.conversationUnavailable"
    );
  });

  it("shows the timeline skeleton instead of unavailable empty while active conversation messages are loading", () => {
    const conversation = {
      id: "session-1",
      provider: "codex" as const,
      title: "Session 1",
      status: "ready" as const,
      cwd: "/workspace",
      updatedAtUnixMs: 1
    };
    mockViewModel = createViewModel({
      conversations: [conversation],
      activeConversation: conversation,
      activeConversationId: "session-1",
      isLoadingMessages: true
    });

    renderAgentGUINode();

    expect(
      screen.getByTestId("agent-gui-transcript-loading-skeleton")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-gui-unavailable-chat-empty")
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("agent-gui-timeline")).not.toHaveClass(
      "agent-gui-node__timeline-unavailable-chat-empty"
    );
  });

  it("lets session list items receive clicks inside the node window", () => {
    mockViewModel = createViewModel({
      conversations: [
        {
          id: "session-1",
          agentTargetId: "local:codex",
          provider: "codex",
          title: "Session 1",
          status: "ready",
          cwd: "/workspace",
          updatedAtUnixMs: 1
        }
      ],
      activeConversationId: "session-1"
    });
    renderAgentGUINode();

    fireEvent.click(screen.getByRole("button", { name: /Session 1/ }));

    expect(mockSelectConversation).toHaveBeenCalledWith("session-1");
  });

  it("collapses and expands project conversation sections from the project row", () => {
    mockViewModel = createViewModel({
      userProjects: [
        {
          id: "project-1",
          label: "App",
          path: "/workspace/app",
          createdAtUnixMs: 1,
          updatedAtUnixMs: 2,
          lastUsedAtUnixMs: 2
        }
      ],
      conversations: [
        {
          id: "session-1",
          agentTargetId: "local:codex",
          provider: "codex",
          title: "Project Session",
          status: "ready",
          cwd: "/workspace/app",
          project: {
            id: "project-1",
            label: "App",
            path: "/workspace/app"
          },
          updatedAtUnixMs: 1
        }
      ],
      activeConversationId: "session-1"
    });
    renderAgentGUINode();

    const projectRow = screen.getByRole("button", { name: "App" });
    expect(projectRow).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: /Project Session/ })
    ).toBeInTheDocument();

    fireEvent.click(projectRow);

    expect(projectRow).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", { name: /Project Session/ })
    ).toBeNull();

    fireEvent.click(projectRow);

    expect(projectRow).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: /Project Session/ })
    ).toBeInTheDocument();
  });

  it("renders mention markdown titles as @session dot text instead of mention tokens", () => {
    const mentionTitle =
      "[@wang jomes & Codex hi](mention://agent-session/session-1?workspaceId=room-1)";
    const conversation = {
      id: "session-1",
      provider: "codex" as const,
      title: mentionTitle,
      status: "ready" as const,
      cwd: "/workspace",
      updatedAtUnixMs: 1
    };
    mockViewModel = createViewModel({
      conversations: [conversation],
      activeConversation: conversation,
      activeConversationId: "session-1",
      conversationDetail: detailViewModel({
        activity: {
          ...detailViewModel().activity,
          title: mentionTitle
        },
        session: {
          ...detailViewModel().session,
          title: mentionTitle
        }
      })
    });

    const { container } = renderAgentGUINode();
    const titleRoots = container.querySelectorAll(
      ".agent-gui-node__conversation-title, .agent-gui-node__detail-header-title"
    );

    expect(screen.queryByText(mentionTitle)).toBeNull();
    expect(
      screen.getAllByText("@session · wang jomes & Codex hi").length
    ).toBeGreaterThan(0);
    for (const root of titleRoots) {
      expect(root.querySelector('[data-agent-file-mention="true"]')).toBeNull();
    }
  });

  it("formats plain session-style titles as @session dot text instead of mention tokens", () => {
    const plainTitle = "@Jun Sun & Claude Code 看看文件夹有什么内容 总结下这里";
    const conversation = {
      id: "session-1",
      provider: "claude-code" as const,
      title: plainTitle,
      status: "ready" as const,
      cwd: "/workspace",
      updatedAtUnixMs: 1
    };
    mockViewModel = createViewModel({
      conversations: [conversation],
      activeConversation: conversation,
      activeConversationId: "session-1",
      conversationDetail: detailViewModel({
        activity: {
          ...detailViewModel().activity,
          title: plainTitle
        },
        session: {
          ...detailViewModel().session,
          title: plainTitle
        }
      })
    });

    const { container } = renderAgentGUINode();
    const titleRoots = container.querySelectorAll(
      ".agent-gui-node__conversation-title"
    );

    expect(
      screen.getAllByText(
        "@session · Jun Sun & Claude Code 看看文件夹有什么内容 总结下这里"
      ).length
    ).toBeGreaterThan(0);
    for (const root of titleRoots) {
      expect(root.querySelector('[data-agent-file-mention="true"]')).toBeNull();
    }
  });
  it("filters conversations from the sidebar search field", () => {
    mockViewModel = createViewModel({
      conversations: [
        {
          id: "session-1",
          provider: "codex",
          title: "优化 Agent-GUI 对话布局",
          status: "ready",
          cwd: "/workspace",
          updatedAtUnixMs: 1
        },
        {
          id: "session-2",
          provider: "codex",
          title: "分析 harness 功能设计",
          status: "working",
          cwd: "/workspace",
          updatedAtUnixMs: 2
        }
      ],
      activeConversationId: "session-1"
    });

    renderAgentGUINode();

    fireEvent.change(
      screen.getByPlaceholderText("agentHost.agentGui.searchPlaceholder"),
      {
        target: { value: "harness" }
      }
    );

    expect(
      screen.queryByRole("button", { name: /优化 Agent-GUI 对话布局/ })
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /分析 harness 功能设计/ })
    ).toBeTruthy();
  });

  it("renders the search empty state when no conversations match the query", () => {
    mockViewModel = createViewModel({
      conversations: [
        {
          id: "session-1",
          provider: "codex",
          title: "优化 Agent-GUI 对话布局",
          status: "ready",
          cwd: "/workspace",
          updatedAtUnixMs: 1
        }
      ],
      activeConversationId: "session-1"
    });

    renderAgentGUINode();

    fireEvent.change(
      screen.getByPlaceholderText("agentHost.agentGui.searchPlaceholder"),
      {
        target: { value: "not-found" }
      }
    );

    expect(
      screen.getByText("agentHost.agentGui.searchNoConversations")
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /优化 Agent-GUI 对话布局/ })
    ).toBeNull();
  });

  it("opens delete confirmation from the icon-only conversation action without selecting", () => {
    mockViewModel = createViewModel({
      conversations: [
        {
          id: "session-1",
          provider: "codex",
          title: "Session 1",
          status: "ready",
          cwd: "/workspace",
          updatedAtUnixMs: 1
        }
      ],
      activeConversationId: "session-1"
    });
    renderAgentGUINode();

    fireEvent.click(
      screen.getByRole("button", { name: "agentHost.agentGui.deleteSession" })
    );

    expect(mockRequestDeleteConversation).toHaveBeenCalledWith("session-1");
    expect(mockSelectConversation).not.toHaveBeenCalled();
  });

  it("opens a conversation in a new window from the rail action without selecting", () => {
    const onOpenConversationWindow =
      vi.fn<
        NonNullable<
          React.ComponentProps<typeof AgentGUINode>["onOpenConversationWindow"]
        >
      >();
    mockViewModel = createViewModel({
      conversations: [
        {
          id: "session-1",
          provider: "codex",
          title: "Session 1",
          status: "ready",
          cwd: "/workspace",
          updatedAtUnixMs: 1
        }
      ],
      activeConversationId: "session-1"
    });
    renderAgentGUINode({ onOpenConversationWindow });

    fireEvent.click(
      screen.getByRole("button", {
        name: "agentHost.agentGui.openConversationWindow"
      })
    );

    expect(onOpenConversationWindow).toHaveBeenCalledWith("session-1");
    expect(mockSelectConversation).not.toHaveBeenCalled();
  });

  it("opens a conversation in a new window from the rail context menu without selecting", async () => {
    const onOpenConversationWindow =
      vi.fn<
        NonNullable<
          React.ComponentProps<typeof AgentGUINode>["onOpenConversationWindow"]
        >
      >();
    mockViewModel = createViewModel({
      conversations: [
        {
          id: "session-1",
          provider: "codex",
          title: "Session 1",
          status: "ready",
          cwd: "/workspace",
          updatedAtUnixMs: 1
        }
      ],
      activeConversationId: "session-1"
    });
    renderAgentGUINode({ onOpenConversationWindow });

    fireEvent.contextMenu(
      screen.getByTestId("agent-gui-conversation-item-session-1")
    );
    const openWindowMenuItem = await screen.findByRole("menuitem", {
      name: "agentHost.agentGui.openConversationWindow"
    });
    fireEvent.pointerUp(openWindowMenuItem, { button: 0 });

    await waitFor(() =>
      expect(
        screen.queryByRole("menuitem", {
          name: "agentHost.agentGui.openConversationWindow"
        })
      ).not.toBeInTheDocument()
    );

    await waitFor(() =>
      expect(onOpenConversationWindow).toHaveBeenCalledWith("session-1")
    );
    expect(mockSelectConversation).not.toHaveBeenCalled();
  });

  it("opens rename dialog from rail double-click and saves through controller action", async () => {
    mockRenameConversation.mockResolvedValue(undefined);
    mockViewModel = createViewModel({
      conversations: [
        {
          id: "session-1",
          provider: "codex",
          title: "Session 1",
          status: "ready",
          cwd: "/workspace",
          updatedAtUnixMs: 1
        }
      ],
      activeConversationId: "session-1"
    });
    renderAgentGUINode();

    fireEvent.doubleClick(screen.getByRole("button", { name: /Session 1/ }));
    const input = screen.getByRole("textbox", {
      name: "agentHost.agentGui.renameSessionTitle"
    });
    fireEvent.change(input, { target: { value: "Renamed session" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockRenameConversation).toHaveBeenCalledWith(
        "session-1",
        "Renamed session"
      );
    });
  });

  it("does not submit a blank rename title", async () => {
    mockRenameConversation.mockResolvedValue(undefined);
    mockViewModel = createViewModel({
      conversations: [
        {
          id: "session-1",
          provider: "codex",
          title: "Session 1",
          status: "ready",
          cwd: "/workspace",
          updatedAtUnixMs: 1
        }
      ],
      activeConversationId: "session-1"
    });
    renderAgentGUINode();

    fireEvent.doubleClick(screen.getByRole("button", { name: /Session 1/ }));
    const input = screen.getByRole("textbox", {
      name: "agentHost.agentGui.renameSessionTitle"
    });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      screen.getByRole("button", {
        name: "agentHost.agentGui.renameSessionSave"
      })
    ).toBeDisabled();
    expect(mockRenameConversation).not.toHaveBeenCalled();
  });

  it("closes the rename dialog from cancel", async () => {
    mockViewModel = createViewModel({
      conversations: [
        {
          id: "session-1",
          provider: "codex",
          title: "Session 1",
          status: "ready",
          cwd: "/workspace",
          updatedAtUnixMs: 1
        }
      ],
      activeConversationId: "session-1"
    });
    renderAgentGUINode();

    fireEvent.doubleClick(screen.getByRole("button", { name: /Session 1/ }));
    expect(
      await screen.findByRole("textbox", {
        name: "agentHost.agentGui.renameSessionTitle"
      })
    ).toBeInTheDocument();

    fireEvent.pointerUp(screen.getByRole("button", { name: "common.cancel" }), {
      button: 0
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", {
          name: "agentHost.agentGui.renameSessionTitle"
        })
      ).toBeNull();
    });
  });

  it("copies a conversation mention link from the rail context menu without selecting", async () => {
    mockViewModel = createViewModel({
      conversations: [
        {
          id: "session-1",
          agentTargetId: "local:codex",
          provider: "codex",
          title: "Session [1] \\ draft",
          status: "ready",
          cwd: "/workspace",
          updatedAtUnixMs: 1
        }
      ],
      activeConversationId: "session-1"
    });
    renderAgentGUINode();

    fireEvent.contextMenu(
      screen.getByTestId("agent-gui-conversation-item-session-1")
    );
    const copyLinkMenuItem = await screen.findByRole("menuitem", {
      name: "agentHost.agentGui.copySessionLink"
    });
    fireEvent.pointerUp(copyLinkMenuItem, { button: 0 });

    await waitFor(() =>
      expect(mockWriteClipboardText).toHaveBeenCalledWith(
        "[Session \\[1\\] \\\\ draft](mention://agent-session/session-1?agentTargetId=local%3Acodex&workspaceId=room-1)"
      )
    );
    expect(mockSelectConversation).not.toHaveBeenCalled();
  });

  it("opens rename dialog from the rail context menu", async () => {
    mockViewModel = createViewModel({
      conversations: [
        {
          id: "session-1",
          provider: "codex",
          title: "Session 1",
          status: "ready",
          cwd: "/workspace",
          updatedAtUnixMs: 1
        }
      ],
      activeConversationId: "session-1"
    });
    renderAgentGUINode();

    fireEvent.contextMenu(
      screen.getByTestId("agent-gui-conversation-item-session-1")
    );
    const renameMenuItem = await screen.findByRole("menuitem", {
      name: "agentHost.agentGui.renameSession"
    });
    fireEvent.pointerUp(renameMenuItem, { button: 0 });

    await waitFor(() =>
      expect(
        screen.queryByRole("menuitem", {
          name: "agentHost.agentGui.renameSession"
        })
      ).not.toBeInTheDocument()
    );

    expect(
      await screen.findByRole("textbox", {
        name: "agentHost.agentGui.renameSessionTitle"
      })
    ).toHaveValue("Session 1");
  });

  it("opens rename dialog from a runtime section row that is missing from the view model", async () => {
    mockRenameConversation.mockResolvedValue(undefined);
    mockViewModel = createViewModel({
      conversations: [],
      activeConversation: null,
      activeConversationId: null
    });
    const agentActivityRuntime = {
      ...createNoopAgentActivityRuntime(),
      async listSessionSections(input) {
        return {
          workspaceId: input.workspaceId,
          sections: [
            {
              kind: "conversations" as const,
              sectionKey: "conversations",
              sessions: [
                {
                  workspaceId: input.workspaceId,
                  agentSessionId: "section-session-1",
                  provider: "codex",
                  cwd: "/workspace",
                  title: "Section session",
                  status: "completed",
                  visible: true,
                  updatedAtUnixMs: 1,
                  lastEventUnixMs: 1
                }
              ],
              hasMore: false
            }
          ]
        };
      },
      async listSessionSectionPage(input) {
        return {
          kind: "conversations" as const,
          sectionKey: input.sectionKey,
          sessions: [],
          hasMore: false
        };
      }
    } satisfies AgentActivityRuntime;
    renderAgentGUINode({ agentActivityRuntime });

    fireEvent.contextMenu(
      await screen.findByTestId("agent-gui-conversation-item-section-session-1")
    );
    const renameMenuItem = await screen.findByRole("menuitem", {
      name: "agentHost.agentGui.renameSession"
    });
    fireEvent.pointerUp(renameMenuItem, { button: 0 });

    expect(
      await screen.findByRole("textbox", {
        name: "agentHost.agentGui.renameSessionTitle"
      })
    ).toHaveValue("Section session");
  });

  it("renders inline delete confirmation and dispatches confirm without a dialog", () => {
    mockViewModel = createViewModel({
      conversations: [
        {
          id: "session-1",
          provider: "codex",
          title: "Session 1",
          status: "ready",
          cwd: "/workspace",
          updatedAtUnixMs: 1
        }
      ],
      pendingDeleteConversation: {
        id: "session-1",
        provider: "codex",
        title: "Session 1",
        status: "ready",
        cwd: "/workspace",
        updatedAtUnixMs: 1
      }
    });
    renderAgentGUINode();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "agentHost.agentGui.deleteSessionConfirm"
      })
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "agentHost.agentGui.deleteSessionConfirm"
      })
    );

    expect(mockConfirmDeleteConversation).toHaveBeenCalledTimes(1);
  });

  it("only disables the pending delete button while a deletion is in flight", () => {
    mockViewModel = createViewModel({
      conversations: [
        {
          id: "session-1",
          provider: "codex",
          title: "Session 1",
          status: "ready",
          cwd: "/workspace",
          updatedAtUnixMs: 2
        },
        {
          id: "session-2",
          provider: "codex",
          title: "Session 2",
          status: "ready",
          cwd: "/workspace",
          updatedAtUnixMs: 1
        }
      ],
      pendingDeleteConversation: {
        id: "session-1",
        provider: "codex",
        title: "Session 1",
        status: "ready",
        cwd: "/workspace",
        updatedAtUnixMs: 2
      },
      isDeletingConversation: true
    });
    renderAgentGUINode();

    expect(
      screen.getByRole("button", {
        name: "agentHost.agentGui.deleteSessionConfirm"
      })
    ).toBeDisabled();
    expect(
      screen.getAllByRole("button", {
        name: "agentHost.agentGui.deleteSession"
      })[0]
    ).not.toBeDisabled();
  });

  it("cancels inline delete confirmation when hover leaves the conversation row", () => {
    mockViewModel = createViewModel({
      conversations: [
        {
          id: "session-1",
          provider: "codex",
          title: "Session 1",
          status: "ready",
          cwd: "/workspace",
          updatedAtUnixMs: 1
        }
      ],
      pendingDeleteConversation: {
        id: "session-1",
        provider: "codex",
        title: "Session 1",
        status: "ready",
        cwd: "/workspace",
        updatedAtUnixMs: 1
      }
    });
    renderAgentGUINode();

    fireEvent.mouseLeave(
      screen.getByTestId("agent-gui-conversation-item-session-1")
    );

    expect(mockCancelDeleteConversation).toHaveBeenCalledTimes(1);
  });

  it("shows unread completion as a blue status lamp until the conversation is viewed", () => {
    mockViewModel = createViewModel({
      conversations: [
        {
          id: "session-1",
          provider: "codex",
          title: "Session 1",
          status: "completed",
          cwd: "/workspace",
          updatedAtUnixMs: 1,
          hasUnreadCompletion: true
        }
      ],
      activeConversationId: null
    });
    renderAgentGUINode();

    expect(
      screen.getByTestId("agent-gui-conversation-meta-session-1")
    ).toHaveAttribute("data-kind", "unread-complete");
  });

  it("shows a spinner for working conversations, a warning glyph for waiting ones, and relative time for settled ones", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T17:20:00Z"));
    mockViewModel = createViewModel({
      conversations: [
        {
          id: "working-session",
          provider: "codex",
          title: "Working Session",
          status: "working",
          cwd: "/workspace",
          updatedAtUnixMs: new Date("2026-05-18T17:19:30Z").getTime()
        },
        {
          id: "waiting-session",
          provider: "codex",
          title: "Waiting Session",
          status: "waiting",
          cwd: "/workspace",
          updatedAtUnixMs: new Date("2026-05-18T17:18:30Z").getTime()
        },
        {
          id: "done-session",
          provider: "codex",
          title: "Done Session",
          status: "completed",
          cwd: "/workspace",
          updatedAtUnixMs: new Date("2026-05-18T17:12:00Z").getTime()
        }
      ],
      activeConversationId: null
    });
    renderAgentGUINode();

    expect(
      screen.getByTestId("agent-gui-conversation-meta-working-session")
    ).toHaveAttribute("data-kind", "loading");
    expect(
      within(
        screen.getByTestId("agent-gui-conversation-meta-working-session")
      ).getByTestId("agent-gui-conversation-spinner")
    ).toHaveStyle({ color: "var(--text-secondary)" });
    const waitingMeta = screen.getByTestId(
      "agent-gui-conversation-meta-waiting-session"
    );
    expect(waitingMeta).toHaveAttribute("data-kind", "waiting");
    expect(
      within(waitingMeta).queryByTestId("agent-gui-conversation-spinner")
    ).toBeNull();
    expect(waitingMeta.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("8 分钟")).toBeTruthy();
    vi.useRealTimers();
  });

  it("refreshes relative time labels every minute while the session list stays open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T17:20:00Z"));
    mockViewModel = createViewModel({
      conversations: [
        {
          id: "recent-session",
          provider: "codex",
          title: "Recent Session",
          status: "completed",
          cwd: "/workspace",
          updatedAtUnixMs: new Date("2026-05-18T17:19:30Z").getTime()
        }
      ],
      activeConversationId: null
    });

    renderAgentGUINode();

    expect(screen.getByText("刚刚")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.getByText("1 分钟")).toBeTruthy();
    vi.useRealTimers();
  });

  it("formats older settled conversations with month and year units", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T17:20:00Z"));
    mockViewModel = createViewModel({
      conversations: [
        {
          id: "month-session",
          provider: "codex",
          title: "Month Session",
          status: "completed",
          cwd: "/workspace",
          updatedAtUnixMs: new Date("2026-02-17T17:20:00Z").getTime()
        },
        {
          id: "year-session",
          provider: "codex",
          title: "Year Session",
          status: "completed",
          cwd: "/workspace",
          updatedAtUnixMs: new Date("2024-03-18T17:20:00Z").getTime()
        }
      ],
      activeConversationId: null
    });

    renderAgentGUINode();

    expect(screen.getByText("3 个月")).toBeTruthy();
    expect(screen.getByText("2 年")).toBeTruthy();
    vi.useRealTimers();
  });

  it("shows the pending sync status indicator while cloud sync is still in flight", () => {
    const conversation = {
      id: "session-1",
      provider: "codex" as const,
      title: "Session 1",
      status: "working" as const,
      cwd: "/workspace",
      updatedAtUnixMs: 1,
      syncState: { agentSessionId: "session-1", status: "pending" }
    };
    mockViewModel = createViewModel({
      conversations: [conversation],
      activeConversation: conversation,
      activeConversationId: "session-1"
    });
    renderAgentGUINode();

    expect(
      screen.getByLabelText("agentHost.agentGui.syncPending")
    ).toBeTruthy();
  });

  it("keeps the sync status indicator visible after cloud sync settles", () => {
    const conversation = {
      id: "session-1",
      provider: "codex" as const,
      title: "Session 1",
      status: "ready" as const,
      cwd: "/workspace",
      updatedAtUnixMs: 1,
      syncState: { agentSessionId: "session-1", status: "synced" }
    };
    mockViewModel = createViewModel({
      conversations: [conversation],
      activeConversation: conversation,
      activeConversationId: "session-1"
    });
    renderAgentGUINode();

    expect(screen.getByLabelText("agentHost.agentGui.syncSynced")).toBeTruthy();
  });

  it("shows a failed sync status indicator when cloud sync reports an error", () => {
    const conversation = {
      id: "session-1",
      provider: "codex" as const,
      title: "Session 1",
      status: "ready" as const,
      cwd: "/workspace",
      updatedAtUnixMs: 1,
      syncState: { agentSessionId: "session-1", status: "failed" }
    };
    mockViewModel = createViewModel({
      conversations: [conversation],
      activeConversation: conversation,
      activeConversationId: "session-1"
    });
    renderAgentGUINode();

    expect(screen.getByLabelText("agentHost.agentGui.syncFailed")).toBeTruthy();
    expect(screen.getByText("agentHost.agentGui.syncFailed")).toBeTruthy();
  });

  it("shows the sync hint on hover for the session status group", () => {
    const conversation = {
      id: "session-1",
      provider: "codex" as const,
      title: "Session 1",
      status: "working" as const,
      cwd: "/workspace",
      updatedAtUnixMs: 1,
      syncState: { agentSessionId: "session-1", status: "failed" }
    };
    mockViewModel = createViewModel({
      conversations: [conversation],
      activeConversation: conversation,
      activeConversationId: "session-1",
      conversationDetail: detailViewModel()
    });
    renderAgentGUINode();

    // The session status group surfaces the failed-sync hint: the label is shown
    // and its containing group carries the hint as a hover title.
    const syncHint = screen.getByText("agentHost.agentGui.syncFailed");
    expect(syncHint.parentElement).toHaveAttribute(
      "title",
      "agentHost.agentGui.syncFailed"
    );
  });

  it("does not show a sync indicator for active conversations without sync metadata", () => {
    const conversation = {
      id: "session-1",
      provider: "codex" as const,
      title: "Session 1",
      status: "ready" as const,
      cwd: "/workspace",
      updatedAtUnixMs: 1
    };
    mockViewModel = createViewModel({
      conversations: [conversation],
      activeConversation: conversation,
      activeConversationId: "session-1"
    });
    renderAgentGUINode();

    expect(screen.queryByLabelText("agentHost.agentGui.syncSynced")).toBeNull();
  });

  it("lets the composer editor and send button receive input inside the node window", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "hello"
    });
    renderAgentGUINode();

    pasteComposerText(" world");
    await waitFor(() => expect(mockUpdateDraftContent).toHaveBeenCalled());
    const sendButton = screen.getByRole("button", {
      name: "agentHost.agentGui.send"
    });
    const sendIconPath = sendButton.querySelector("path");
    expect(sendButton.className).toContain(
      "agent-gui-node__composer-send-button"
    );
    expect(sendIconPath).toHaveAttribute("fill", "currentColor");
    expect(sendIconPath).toHaveAttribute(
      "d",
      expect.stringContaining("M2.74311 8.80587C2.84592 8.40096")
    );
    fireEvent.click(sendButton);

    expect(mockSubmitPrompt).toHaveBeenCalledWith(promptBlocks("hello world"));
  });

  it("disables direct replies for another user's conversation", () => {
    const conversation = {
      id: "session-1",
      userId: "user-2",
      provider: "codex" as const,
      title: "Session 1",
      status: "ready" as const,
      cwd: "/workspace",
      updatedAtUnixMs: 1
    };
    mockViewModel = createViewModel({
      currentUserId: "user-1",
      activeConversation: conversation,
      activeConversationId: conversation.id,
      conversations: [conversation],
      draftPrompt: "hello",
      canQueueWhileBusy: true
    });
    renderAgentGUINode();

    const editor = screen.getByRole("textbox", {
      name: "非当前用户会话，不可直接对话"
    });
    expect(editor).toHaveAttribute("aria-disabled", "true");
    expect(
      editor.closest(".agent-gui-node__composer-input-shell")
    ).toHaveAttribute("data-input-disabled", "true");
    expect(
      editor.closest(".agent-gui-node__composer-input-shell")
    ).toHaveAttribute("title", "非当前用户会话，不可直接对话");
    const sendButton = screen.getByRole("button", {
      name: "agentHost.agentGui.send"
    });
    expect(sendButton).toBeDisabled();
    expect(sendButton).toHaveAttribute("data-state", "send");
  });

  it("keeps the composer enabled for the current user's conversation", () => {
    const conversation = {
      id: "session-1",
      userId: "user-1",
      provider: "codex" as const,
      title: "Session 1",
      status: "ready" as const,
      cwd: "/workspace",
      updatedAtUnixMs: 1
    };
    mockViewModel = createViewModel({
      currentUserId: "user-1",
      activeConversation: conversation,
      activeConversationId: conversation.id,
      conversations: [conversation],
      draftPrompt: "hello"
    });
    renderAgentGUINode();

    const editor = getComposerEditor();
    expect(editor).not.toHaveAttribute("aria-disabled", "true");
    expect(
      editor.closest(".agent-gui-node__composer-input-shell")
    ).not.toHaveAttribute("data-input-disabled");
    expect(
      editor.closest(".agent-gui-node__composer-input-shell")
    ).not.toHaveAttribute("title");
    expect(
      screen.getByRole("button", { name: "agentHost.agentGui.send" })
    ).not.toBeDisabled();
  });

  it("disables the composer when the current user has not installed the active Agent GUI provider", () => {
    mockViewModel = createViewModel({
      data: {
        provider: "claude-code",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      activeConversationId: "session-1",
      draftPrompt: "",
      canQueueWhileBusy: true
    });

    renderAgentGUINode({
      state: {
        provider: "claude-code",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      managedAgentsState: createManagedAgentsState({
        readyAgentIds: ["codex"],
        items: [
          createManagedAgentsStateItem({
            toolId: "claude-code-cli",
            agentId: "claude-code",
            hostDetected: true
          })
        ]
      })
    });

    expect(getComposerEditor()).toHaveAttribute("aria-disabled", "true");
    expect(
      getComposerEditor().closest(".agent-gui-node__composer-input-shell")
    ).toHaveAttribute("data-input-disabled", "true");
    expect(
      screen.getByRole("textbox", {
        name: "agentHost.agentGui.installRequiredPlaceholder"
      })
    ).toBeTruthy();
    expect(
      screen.queryByTestId("agent-gui-composer-disabled-reason")
    ).toBeNull();
    expect(
      screen.getByTestId("agent-gui-provider-setup-notice")
    ).toHaveTextContent("agentHost.agentGui.installRequiredPlaceholder");
    expect(
      screen.getByRole("button", { name: "agentHost.agentGui.send" })
    ).toBeDisabled();
    const sendButton = screen.getByRole("button", {
      name: "agentHost.agentGui.send"
    });
    expect(sendButton).toHaveAttribute("data-state", "send");
    expect(screen.queryByTestId("agent-gui-composer-send-spinner")).toBeNull();
  });

  it("keeps the composer ready while managed agent install state is still loading", () => {
    mockViewModel = createViewModel({
      data: {
        provider: "codex",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      activeConversationId: "session-1",
      draftPrompt: "@请处理这个任务引用。",
      canQueueWhileBusy: true
    });

    renderAgentGUINode({
      managedAgentsState: null
    });

    expect(getComposerEditor()).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByTestId("agent-gui-provider-setup-notice")).toBeNull();
    expect(
      screen.getByRole("button", { name: "agentHost.agentGui.send" })
    ).not.toBeDisabled();
  });

  it("checks empty-home provider readiness against the selected provider target before legacy node provider", () => {
    mockViewModel = createViewModel({
      data: {
        provider: "claude-code",
        agentTargetId: "local:claude-code",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      selectedProviderTarget: {
        ...createLocalAgentGUIProviderTarget("claude-code"),
        agentTargetId: "local:claude-code"
      },
      activeConversation: null,
      activeConversationId: null,
      draftPrompt: "hello",
      canQueueWhileBusy: true,
      providerReadinessGate: null
    });

    renderAgentGUINode({
      state: {
        provider: "codex",
        agentTargetId: "local:claude-code",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      managedAgentsState: createManagedAgentsState({
        readyAgentIds: ["claude-code"],
        items: [
          createManagedAgentsStateItem({
            toolId: "codex-cli",
            agentId: "codex",
            hostDetected: true
          }),
          createManagedAgentsStateItem({
            toolId: "claude-code-cli",
            agentId: "claude-code",
            hostDetected: true
          })
        ]
      })
    });

    expect(getComposerEditor()).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByTestId("agent-gui-provider-setup-notice")).toBeNull();
    expect(
      screen.getByRole("button", { name: "agentHost.agentGui.send" })
    ).not.toBeDisabled();
  });

  it("shows a provider setup notice while keeping the disabled composer reason on the input placeholder", () => {
    mockViewModel = createViewModel({
      data: {
        provider: "claude-code",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      activeConversationId: "session-1",
      draftPrompt: "hello",
      canQueueWhileBusy: true
    });

    renderAgentGUINode({
      state: {
        provider: "claude-code",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      managedAgentsState: createManagedAgentsState({
        readyAgentIds: ["codex"]
      })
    });

    expect(
      screen.getByRole("textbox", {
        name: "agentHost.agentGui.installRequiredPlaceholder"
      })
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.queryByTestId("agent-gui-composer-disabled-reason")
    ).toBeNull();
    expect(
      screen.getByTestId("agent-gui-provider-setup-notice")
    ).toHaveTextContent("agentHost.agentGui.installRequiredPlaceholder");
  });

  it("opens the provider setup panel from the setup notice action", () => {
    mockViewModel = createViewModel({
      data: {
        provider: "claude-code",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      activeConversationId: "session-1",
      draftPrompt: "hello",
      canQueueWhileBusy: true
    });

    renderAgentGUINode({
      state: {
        provider: "claude-code",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      managedAgentsState: createManagedAgentsState({
        readyAgentIds: ["codex"]
      })
    });

    fireEvent.pointerDown(
      screen.getByTestId("agent-gui-provider-setup-notice-action")
    );
    fireEvent.click(
      screen.getByTestId("agent-gui-provider-setup-notice-action")
    );

    expect(getAgentEnvPanelStore()).toMatchObject({
      open: true,
      provider: "claude-code",
      focus: "detect"
    });
  });

  it("renders composer setting controls with permission mode UI", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      composerSettings: {
        sessionSettings: {
          model: "gpt-5",
          reasoningEffort: "high",
          speed: null,
          planMode: false,
          permissionModeId: "auto"
        },
        draftSettings: {
          model: "gpt-5",
          reasoningEffort: "high",
          speed: null,
          planMode: false,
          permissionModeId: "preset"
        },
        supportsModel: true,
        supportsReasoningEffort: true,
        supportsSpeed: true,
        speedUnavailable: false,
        availableSpeeds: [],
        supportsPermissionMode: true,
        supportsPlanMode: true,
        isSettingsLoading: false,
        modelUnavailable: false,
        reasoningUnavailable: false,
        permissionModeUnavailable: false,
        selectedPermissionModeValue: "preset",
        availableModels: [
          { value: "gpt-5", label: "GPT-5" },
          { value: "gpt-5.5", label: "GPT-5.5" }
        ],
        availableReasoningEfforts: [{ value: "high", label: "High" }],
        availablePermissionModes: [
          {
            value: "read-only",
            label: "agentHost.agentGui.permissionModeReadOnly"
          },
          { value: "auto", label: "agentHost.agentGui.permissionModeAuto" },
          {
            value: "full-access",
            label: "agentHost.agentGui.permissionModeFullAccess"
          }
        ]
      }
    });
    const view = renderAgentGUINode();

    const modelTriggerName =
      "agentHost.agentGui.modelLabel / agentHost.agentGui.reasoningLabel";
    fireEvent.pointerDown(
      screen.getByRole("button", { name: modelTriggerName }),
      { button: 0, ctrlKey: false, pointerId: 3, pointerType: "mouse" }
    );
    expect(screen.queryByText("agentHost.agentGui.modelLabel")).toBeNull();
    // Model is the primary list; reasoning is a submenu reflecting the value.
    // (Model/reasoning selection wiring is covered by the dedicated
    // AgentComposerSettingsMenus spec; here we only assert the controls
    // render and that permission selection still drives updateComposerSettings.)
    expect(
      await screen.findByRole("menuitem", { name: /GPT-5\.5/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", {
        name: /agentHost\.agentGui\.reasoningLabel/
      })
    ).toHaveTextContent("agentHost.agentGui.reasoningOptionHigh");
    // Close the model menu (jsdom does not run radix's pointerup-to-close).
    const openModelMenu = screen.queryByRole("menu");
    if (openModelMenu) {
      fireEvent.keyDown(openModelMenu, { key: "Escape" });
    }

    fireEvent.keyDown(
      await screen.findByRole("combobox", {
        name: "agentHost.agentGui.permissionLabel"
      }),
      { key: "Enter" }
    );
    fireEvent.pointerDown(
      await screen.findByRole("option", {
        name: /full-access|agentHost\.agentGui\.permissionModeFullAccess/
      }),
      { button: 0, ctrlKey: false, pointerId: 5, pointerType: "mouse" }
    );

    expect(mockUpdateComposerSettings).toHaveBeenCalledWith({
      permissionModeId: "full-access"
    });
    view.unmount();
  }, 15000);

  it("renders the plan badge when plan mode is active and clears it on click", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      composerSettings: {
        sessionSettings: {
          model: "claude-4",
          reasoningEffort: "high",
          speed: null,
          planMode: true,
          permissionModeId: "default"
        },
        draftSettings: {
          model: "claude-4",
          reasoningEffort: "high",
          speed: null,
          planMode: true,
          permissionModeId: "default"
        },
        supportsModel: true,
        supportsReasoningEffort: true,
        supportsSpeed: true,
        speedUnavailable: false,
        availableSpeeds: [],
        supportsPermissionMode: true,
        supportsPlanMode: true,
        isSettingsLoading: false,
        modelUnavailable: false,
        reasoningUnavailable: false,
        permissionModeUnavailable: false,
        selectedPermissionModeValue: "default",
        availableModels: [{ value: "claude-4", label: "Claude 4" }],
        availableReasoningEfforts: [{ value: "high", label: "High" }],
        availablePermissionModes: [
          { value: "default", label: "agentHost.agentGui.permissionModeAsk" }
        ]
      }
    });
    renderAgentGUINode();

    // Plan mode is no longer a dropdown option; it rides as a separate badge.
    expect(
      screen.queryByRole("option", {
        name: "agentHost.agentGui.planModeLabel"
      })
    ).toBeNull();

    const badge = screen.getByRole("button", {
      name: "agentHost.agentGui.planModeLabel"
    });
    fireEvent.click(badge);

    expect(mockUpdateComposerSettings).toHaveBeenCalledWith({
      planMode: false
    });
  });

  it("enables plan mode on shift+tab", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      composerSettings: {
        sessionSettings: null,
        draftSettings: {
          model: "claude-4",
          reasoningEffort: "high",
          speed: null,
          planMode: false,
          permissionModeId: "acceptEdits"
        },
        supportsModel: true,
        supportsReasoningEffort: true,
        supportsSpeed: true,
        speedUnavailable: false,
        availableSpeeds: [],
        supportsPermissionMode: true,
        supportsPlanMode: true,
        isSettingsLoading: false,
        modelUnavailable: false,
        reasoningUnavailable: false,
        permissionModeUnavailable: false,
        selectedPermissionModeValue: "acceptEdits",
        availableModels: [{ value: "claude-4", label: "Claude 4" }],
        availableReasoningEfforts: [{ value: "high", label: "High" }],
        availablePermissionModes: [
          { value: "default", label: "agentHost.agentGui.permissionModeAsk" },
          { value: "acceptEdits", label: "Accept edits" }
        ]
      }
    });
    renderAgentGUINode();

    fireEvent.keyDown(getComposerEditor(), { key: "Tab", shiftKey: true });

    expect(mockUpdateComposerSettings).toHaveBeenCalledWith({
      planMode: true
    });
  });

  it("disables plan mode on shift+tab", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      composerSettings: {
        sessionSettings: null,
        draftSettings: {
          model: "claude-4",
          reasoningEffort: "high",
          speed: null,
          planMode: true,
          permissionModeId: "acceptEdits"
        },
        supportsModel: true,
        supportsReasoningEffort: true,
        supportsSpeed: true,
        speedUnavailable: false,
        availableSpeeds: [],
        supportsPermissionMode: true,
        supportsPlanMode: true,
        isSettingsLoading: false,
        modelUnavailable: false,
        reasoningUnavailable: false,
        permissionModeUnavailable: false,
        selectedPermissionModeValue: "acceptEdits",
        availableModels: [{ value: "claude-4", label: "Claude 4" }],
        availableReasoningEfforts: [{ value: "high", label: "High" }],
        availablePermissionModes: [
          { value: "default", label: "agentHost.agentGui.permissionModeAsk" },
          { value: "acceptEdits", label: "Accept edits" }
        ]
      }
    });
    renderAgentGUINode();

    fireEvent.keyDown(getComposerEditor(), { key: "Tab", shiftKey: true });

    expect(mockUpdateComposerSettings).toHaveBeenCalledWith({
      planMode: false
    });
  });

  it("renders the codex plan decision in the composer slot and wires its actions", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      pendingInteractivePrompt: {
        kind: "plan-implementation",
        requestId: "plan-turn-1",
        title: "Session 1"
      }
    });
    renderAgentGUINode();

    // The decision card replaces the composer: it lives in the bottom dock and
    // the composer's editor is hidden while the decision is pending.
    expect(
      screen.getByTestId("agent-gui-bottom-dock-active-prompt")
    ).toBeInTheDocument();
    expect(queryComposerEditor()).toBeNull();

    // Action routing goes through the unified interactive-prompt submit path.
    // (implement / skip / feedback dispatch is covered in the surface spec.)
    fireEvent.click(screen.getByTestId("agent-plan-implementation-implement"));
    expect(mockSubmitInteractivePrompt).toHaveBeenCalledWith({
      requestId: "plan-turn-1",
      action: "implement"
    });
  });

  it("keeps the composer when no plan decision is pending", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      pendingInteractivePrompt: null
    });
    renderAgentGUINode();

    expect(
      screen.queryByTestId("agent-plan-implementation-implement")
    ).toBeNull();
    expect(getComposerEditor()).toBeInTheDocument();
  });

  it("omits the plan mode option when the provider lacks the capability", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      composerSettings: {
        sessionSettings: null,
        draftSettings: {
          model: "gpt-5",
          reasoningEffort: "high",
          speed: null,
          planMode: false,
          permissionModeId: "auto"
        },
        supportsModel: true,
        supportsReasoningEffort: true,
        supportsSpeed: true,
        speedUnavailable: false,
        availableSpeeds: [],
        supportsPermissionMode: true,
        supportsPlanMode: false,
        isSettingsLoading: false,
        modelUnavailable: false,
        reasoningUnavailable: false,
        permissionModeUnavailable: false,
        selectedPermissionModeValue: "auto",
        availableModels: [{ value: "gpt-5", label: "GPT-5" }],
        availableReasoningEfforts: [{ value: "high", label: "High" }],
        availablePermissionModes: [
          { value: "auto", label: "agentHost.agentGui.permissionModeAuto" }
        ]
      }
    });
    renderAgentGUINode();

    fireEvent.keyDown(
      screen.getByRole("combobox", {
        name: "agentHost.agentGui.permissionLabel"
      }),
      { key: "Enter" }
    );
    await screen.findByRole("option", {
      name: "agentHost.agentGui.permissionModeAuto"
    });
    expect(
      screen.queryByRole("option", {
        name: "agentHost.agentGui.planModeLabel"
      })
    ).toBeNull();
  });

  it("shows fallback composer defaults for legacy sessions without stored settings", () => {
    mockViewModel = createViewModel({
      data: {
        provider: "codex",
        lastActiveAgentSessionId: "session-1",
        conversationRailWidthPx: null,
        composerOverrides: {
          model: "gpt-5",
          reasoningEffort: "high"
        }
      },
      activeConversationId: "session-1",
      composerSettings: {
        sessionSettings: null,
        draftSettings: {
          model: "gpt-5",
          reasoningEffort: "high",
          speed: null,
          planMode: false,
          permissionModeId: "preset"
        },
        supportsModel: true,
        supportsReasoningEffort: true,
        supportsSpeed: true,
        speedUnavailable: false,
        availableSpeeds: [],
        supportsPlanMode: true,
        isSettingsLoading: false,
        modelUnavailable: false,
        reasoningUnavailable: false,
        availableModels: [{ value: "gpt-5", label: "gpt-5" }],
        availableReasoningEfforts: [{ value: "high", label: "High" }]
      }
    });
    renderAgentGUINode();

    const modelButton = screen.getByRole("button", {
      name: "agentHost.agentGui.modelLabel / agentHost.agentGui.reasoningLabel"
    });
    expect(modelButton).toHaveTextContent("GPT-5");
    expect(modelButton).toHaveTextContent(
      "agentHost.agentGui.reasoningOptionHigh"
    );
    expect(screen.getByTestId("agent-gui-bottom-dock")).toBeTruthy();
  });

  it("hides the model and reasoning dropdown when the provider does not support either setting", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      composerSettings: {
        sessionSettings: null,
        draftSettings: {
          model: null,
          reasoningEffort: null,
          speed: null,
          planMode: false,
          permissionModeId: "preset"
        },
        supportsModel: false,
        supportsReasoningEffort: false,
        supportsSpeed: false,
        speedUnavailable: false,
        availableSpeeds: [],
        supportsPlanMode: false,
        isSettingsLoading: false,
        modelUnavailable: false,
        reasoningUnavailable: false,
        availableModels: [],
        availableReasoningEfforts: []
      }
    });
    renderAgentGUINode();

    expect(
      screen.queryByRole("combobox", {
        name: "agentHost.agentGui.modelLabel / agentHost.agentGui.reasoningLabel"
      })
    ).toBeNull();
  });

  it("keeps the default-model placeholder when no model is selected", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      composerSettings: {
        sessionSettings: {
          model: null,
          reasoningEffort: "high",
          speed: null,
          planMode: false,
          permissionModeId: "auto"
        },
        draftSettings: {
          model: null,
          reasoningEffort: "high",
          speed: null,
          planMode: false,
          browserUse: true,
          permissionModeId: "auto"
        },
        supportsModel: true,
        supportsReasoningEffort: true,
        supportsSpeed: true,
        speedUnavailable: false,
        availableSpeeds: [],
        supportsPlanMode: true,
        isSettingsLoading: false,
        modelUnavailable: false,
        reasoningUnavailable: false,
        availableModels: [
          { value: "gpt-5.5", label: "GPT-5.5" },
          { value: "gpt-5.4", label: "GPT-5.4" }
        ],
        availableReasoningEfforts: [{ value: "high", label: "High" }]
      }
    });
    renderAgentGUINode();

    const modelButton = screen.getByRole("button", {
      name: "agentHost.agentGui.modelLabel / agentHost.agentGui.reasoningLabel"
    });
    expect(modelButton).toHaveTextContent("GPT-5.5");
    expect(modelButton).toHaveTextContent(
      "agentHost.agentGui.reasoningOptionHigh"
    );

    fireEvent.pointerDown(modelButton, {
      button: 0,
      ctrlKey: false,
      pointerId: 7,
      pointerType: "mouse"
    });
    expect(
      await screen.findByRole("menuitem", { name: /GPT-5\.5/ })
    ).toBeInTheDocument();
  });

  it("shows queued prompts in a compact floating panel above the composer", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      queuedPrompts: [
        textQueuedPrompt("queued-1", "follow-up while busy"),
        textQueuedPrompt("queued-2", "ship this after that", 2)
      ],
      canQueueWhileBusy: true,
      canSubmit: false,
      hasSentUserMessage: true
    });
    renderAgentGUINode();

    const composer = getComposerEditor().closest("form");
    expect(composer).not.toBeNull();
    const queuedPromptList = within(composer as HTMLFormElement).getByTestId(
      "agent-gui-composer-queued-prompts"
    );
    expect(
      within(queuedPromptList).getByText("agentHost.agentGui.queuedLabel")
    ).toBeTruthy();
    expect(within(queuedPromptList).getByText("2")).toBeTruthy();
    expect(
      within(queuedPromptList).getByText("follow-up while busy")
    ).toBeTruthy();
    expect(
      within(queuedPromptList).getByText("ship this after that")
    ).toBeTruthy();
    const queuedPromptPanel = queuedPromptList.querySelector(
      ".agent-gui-node__composer-queued-prompt-panel"
    );
    expect(queuedPromptPanel).not.toBeNull();
    expect(queuedPromptPanel).toHaveAttribute("data-expanded", "false");
    fireEvent.click(queuedPromptPanel!);
    expect(queuedPromptPanel).toHaveAttribute("data-expanded", "true");

    const sendQueuedPromptButtons = within(queuedPromptList).getAllByRole(
      "button",
      {
        name: "agentHost.agentGui.sendQueuedPromptNext"
      }
    );
    const deleteQueuedPromptButtons = within(queuedPromptList).getAllByRole(
      "button",
      {
        name: "agentHost.agentGui.deleteQueuedPrompt"
      }
    );
    const moreQueuedPromptButtons = within(queuedPromptList).getAllByRole(
      "button",
      {
        name: "agentHost.agentGui.queuedPromptMoreActions"
      }
    );
    for (const actionButton of [
      ...sendQueuedPromptButtons,
      ...deleteQueuedPromptButtons,
      ...moreQueuedPromptButtons
    ]) {
      expect(actionButton).toHaveClass("h-7");
      expect(actionButton).toHaveClass("w-7");
    }

    fireEvent.click(sendQueuedPromptButtons[1]!);
    expect(mockSendQueuedPromptNext).toHaveBeenCalledWith("queued-2");
    expect(queuedPromptPanel).toHaveAttribute("data-expanded", "true");

    fireEvent.click(deleteQueuedPromptButtons[0]!);
    expect(mockRemoveQueuedPrompt).toHaveBeenCalledTimes(1);
    expect(queuedPromptPanel).toHaveAttribute("data-expanded", "true");
  });

  it("forwards queued prompt mention link actions through the composer", async () => {
    const onLinkAction = vi.fn<(action: WorkspaceLinkAction) => void>();
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      queuedPrompts: [
        textQueuedPrompt(
          "queued-1",
          "follow [@2046494774160003072 & Claude Code Claude Code](mention://agent-session/session-queued?workspaceId=room-1)"
        )
      ],
      canQueueWhileBusy: true,
      canSubmit: false,
      hasSentUserMessage: true
    });
    renderAgentGUINode({ onLinkAction });

    fireEvent.click(
      screen.getByRole("link", {
        name: "2046494774160003072 & Claude Code Claude Code"
      })
    );

    expect(onLinkAction).toHaveBeenCalledWith({
      type: "open-agent-session",
      workspaceId: "room-1",
      agentSessionId: "session-queued",
      source: "agent-markdown"
    });
  });

  it("forwards composer mention link actions without provider fallback", async () => {
    const onLinkAction = vi.fn<(action: WorkspaceLinkAction) => void>();
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt:
        "compare [@2046494774160003072 & Claude Code Claude Code](mention://agent-session/session-draft?workspaceId=room-1)"
    });
    renderAgentGUINode({
      onLinkAction,
      state: { ...createViewModel().data, provider: "codex" }
    });

    const editor = getComposerEditor();
    await waitFor(() =>
      expect(
        editor.querySelector('[data-agent-file-mention="true"]')
      ).toBeInTheDocument()
    );
    fireEvent.click(
      editor.querySelector('[data-agent-file-mention="true"]') as Element
    );

    expect(onLinkAction).toHaveBeenCalledWith({
      type: "open-agent-session",
      workspaceId: "room-1",
      agentSessionId: "session-draft",
      source: "agent-markdown"
    });
  });

  it("switches the composer placeholder after the first user message", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      hasSentUserMessage: true
    });
    renderAgentGUINode();

    expect(
      screen.getByRole("textbox", {
        name: "agentHost.agentGui.followupPlaceholder"
      })
    ).toBeTruthy();
  });

  it("keeps queued prompts visible while an interactive prompt is active", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      canQueueWhileBusy: true,
      canSubmit: false,
      pendingInteractivePrompt: {
        kind: "ask-user",
        requestId: "request-ask",
        title: "Questions for you",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope should we use?",
            options: [{ label: "Small", description: "Minimal change" }],
            multiSelect: false
          }
        ]
      },
      queuedPrompts: [textQueuedPrompt("queued-1", "follow-up while waiting")]
    });
    renderAgentGUINode();

    expect(
      screen.getByTestId("agent-gui-composer-floating-prompt")
    ).toBeTruthy();
    expect(
      screen.getByTestId("agent-gui-composer-queued-prompts")
    ).toBeTruthy();
  });

  it("renders queued workspace app mention icons in the bottom dock", () => {
    const iconUrl = "tutti://workspace-apps/ai-media-canvas/icon.png";
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      activeConversation: {
        id: "session-1",
        provider: "codex",
        title: "Session 1",
        status: "working",
        cwd: "/workspace",
        updatedAtUnixMs: 1
      },
      canQueueWhileBusy: true,
      canSubmit: false,
      hasSentUserMessage: true,
      queuedPrompts: [
        textQueuedPrompt(
          "queued-1",
          "local & Codex [@AI Media Canvas](mention://workspace-app/ai-media-canvas?workspaceId=room-1) 帮我用这个应用生成一批国际象棋图片"
        )
      ]
    });
    renderAgentGUINode({
      workspaceAppIcons: [
        {
          appId: "ai-media-canvas",
          iconUrl,
          workspaceId: "room-1"
        }
      ]
    });

    const queuedPromptList = screen.getByTestId(
      "agent-gui-composer-queued-prompts"
    );
    const mention = queuedPromptList.querySelector(
      '[data-agent-mention-kind="workspace-app"]'
    );
    expect(mention).toHaveTextContent("AI Media Canvas");
    expect(
      mention?.querySelector('[data-agent-mention-app-icon="true"] img')
    ).toHaveAttribute("src", iconUrl);
    expect(queuedPromptList).not.toHaveTextContent("mention://workspace-app");
  });
  it("shows the send button instead of Stop when queueing during a busy turn", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      activeConversation: {
        id: "session-1",
        provider: "codex",
        title: "Session 1",
        status: "working",
        cwd: "/workspace",
        updatedAtUnixMs: 1
      },
      draftPrompt: "queue this next",
      canSubmit: false,
      canQueueWhileBusy: true
    });
    renderAgentGUINode();

    expect(
      screen.getByRole("button", { name: "agentHost.agentGui.send" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "agentHost.agentGui.stop" })
    ).toBeNull();
  });

  it("submits the composer on Enter and keeps Shift+Enter available for new lines", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "hello"
    });
    renderAgentGUINode();

    const editor = getComposerEditor();

    fireEvent.keyDown(editor, { key: "Enter" });

    expect(mockSubmitPrompt).toHaveBeenCalledWith(promptBlocks("hello"));

    mockSubmitPrompt.mockClear();
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });

    expect(mockSubmitPrompt).not.toHaveBeenCalled();
  });

  it("does not submit the composer on Enter when the draft is empty", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: ""
    });
    renderAgentGUINode();

    fireEvent.keyDown(getComposerEditor(), { key: "Enter" });

    expect(mockSubmitPrompt).not.toHaveBeenCalled();
  });

  it("shows Stop in the composer while a conversation is working", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      activeConversation: {
        id: "session-1",
        provider: "codex",
        title: "Session 1",
        status: "working",
        cwd: "/workspace",
        updatedAtUnixMs: 1
      },
      canSubmit: false,
      draftPrompt: "hello"
    });
    renderAgentGUINode();

    expect(
      screen.queryByRole("button", { name: "agentHost.agentGui.send" })
    ).toBeNull();
    const stopButton = screen.getByRole("button", {
      name: "agentHost.agentGui.stop"
    });
    const stopSpinner = screen.getByTestId("agent-gui-composer-stop-spinner");
    const stopSymbol = screen.getByTestId("agent-gui-composer-stop-symbol");
    expect(stopButton.className).toContain("rounded-full");
    expect(stopButton.className).toContain("size-7");
    expect(stopButton.className).toContain("relative");
    expect(stopButton.className).toContain("hover:bg-transparent");
    expect(stopSpinner).toHaveAttribute("data-slot", "spinner");
    expect(stopSpinner).toHaveAttribute("width", "28");
    expect(stopSpinner).toHaveAttribute("height", "28");
    expect(stopSpinner).toHaveClass("size-7");
    expect(stopSymbol.className).toContain("absolute");
    expect(stopSymbol.className).toContain("size-2");
    expect(stopSymbol.className).toContain("rounded-[2px]");
    expect(stopSymbol.className).toContain("bg-current");
    expect(stopSpinner.querySelectorAll("circle")[0]).toHaveAttribute(
      "stroke",
      "var(--transparency-hover)"
    );

    fireEvent.click(stopButton);

    expect(mockInterruptCurrentTurn).toHaveBeenCalledWith(
      "agentHost.agentGui.noRunningResponse"
    );
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
  });

  it("does not keep completed conversations busy when old transcript rows still contain running calls", () => {
    const completedConversation = {
      id: "session-1",
      provider: "codex" as const,
      title: "Session 1",
      status: "completed" as const,
      cwd: "/workspace",
      updatedAtUnixMs: 1
    };
    const completedDetail = detailViewModel({
      activity: {
        ...detailViewModel().activity,
        status: "completed" as const
      },
      session: {
        ...detailViewModel().session,
        lifecycleStatus: "ended",
        turnPhase: "idle",
        effectiveStatus: "completed"
      }
    });
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      activeConversation: completedConversation,
      conversations: [completedConversation],
      conversationDetail: completedDetail,
      conversation: {
        activity: completedDetail.activity,
        workspaceRoot: "/workspace",
        sourceDetail: completedDetail,
        rows: [
          {
            kind: "tool-group",
            id: "tools-running",
            turnId: "turn-1",
            grouped: true,
            calls: [
              {
                kind: "tool-call",
                id: "call-running",
                turnId: "turn-1",
                name: "Read file",
                toolName: "read_file",
                callType: "tool",
                status: "Running",
                statusKind: "working",
                summary: "/workspace/README.md",
                compactSummary: null,
                payload: null,
                toolState: null,
                input: null,
                output: null,
                error: null,
                metadata: null,
                content: null,
                locations: null,
                rendererKind: "default",
                approval: null,
                planMode: null,
                askUserQuestion: null,
                task: null,
                occurredAtUnixMs: 1
              }
            ],
            entries: [],
            occurredAtUnixMs: 1
          }
        ],
        pendingApproval: null,
        pendingInteractivePrompt: null
      },
      canSubmit: false,
      draftPrompt: "hello"
    });
    renderAgentGUINode();

    // A completed conversation must not appear busy even when older transcript
    // rows still contain a running tool call: the composer shows Send, not Stop.
    expect(
      screen.getByRole("button", { name: "agentHost.agentGui.send" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "agentHost.agentGui.stop" })
    ).toBeNull();
  });

  it("keeps the send button in a loading state before switching to Stop", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      activeConversation: {
        id: "session-1",
        provider: "codex",
        title: "Session 1",
        status: "working",
        cwd: "/workspace",
        updatedAtUnixMs: 1
      },
      isSubmitting: true,
      canSubmit: false,
      draftPrompt: "hello"
    });
    renderAgentGUINode();

    expect(
      screen.queryByRole("button", { name: "agentHost.agentGui.stop" })
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "agentHost.agentGui.send" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "agentHost.agentGui.send" })
    ).toHaveAttribute("data-state", "loading");
    expect(screen.getByTestId("agent-gui-composer-send-spinner")).toHaveClass(
      "text-[var(--text-primary)]"
    );
  });

  it("keeps the hero send button in a loading state while creating the first conversation", () => {
    mockViewModel = createViewModel({
      activeConversationId: null,
      isCreatingConversation: true,
      canSubmit: false,
      draftPrompt: "hello"
    });
    renderAgentGUINode();

    expect(
      screen.queryByRole("button", { name: "agentHost.agentGui.stop" })
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "agentHost.agentGui.send" })
    ).toBeDisabled();
  });

  it("disables Stop while an interrupt is already being sent", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      activeConversation: {
        id: "session-1",
        provider: "codex",
        title: "Session 1",
        status: "working",
        cwd: "/workspace",
        updatedAtUnixMs: 1
      },
      isInterrupting: true,
      canSubmit: false
    });
    renderAgentGUINode();

    expect(
      screen.getByRole("button", { name: "agentHost.agentGui.stopping" })
    ).toBeDisabled();
  });

  it("hides Stop when the live session has already failed to recover", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      activeConversation: {
        id: "session-1",
        provider: "codex",
        title: "Session 1",
        status: "working",
        cwd: "/workspace",
        updatedAtUnixMs: 1
      },
      activeLiveState: "failed",
      canSubmit: false
    });
    renderAgentGUINode();

    expect(
      screen.queryByRole("button", { name: "agentHost.agentGui.stop" })
    ).toBeNull();
  });

  it("shows slash commands and selects one without submitting", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/",
      availableCommands: [
        { name: "web", description: "Search the web", inputHint: "query" },
        { name: "read", description: "Read files" }
      ]
    });
    renderAgentGUINode();

    expect(
      screen.getByRole("listbox", {
        name: "agentHost.agentGui.slashCommandPalette"
      })
    ).toBeTruthy();
    expect(screen.getByText("web")).toBeTruthy();

    fireEvent.keyDown(getComposerEditor(), {
      key: "Enter"
    });

    expect(mockUpdateDraftContent).toHaveBeenCalledWith(createDraft("/web "));
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
  });

  it("submits immediate slash commands when selected", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/",
      availableCommands: [
        { name: "init", description: "create an AGENTS.md file" },
        { name: "web", description: "Search the web" }
      ]
    });
    renderAgentGUINode();

    fireEvent.keyDown(getComposerEditor(), { key: "Enter" });

    expect(mockSubmitPrompt).toHaveBeenCalledWith(promptBlocks("/init"));
    expect(mockUpdateDraftContent).toHaveBeenCalledWith(createDraft(""));
    await waitFor(() =>
      expect(getComposerEditor()).not.toHaveTextContent("/init")
    );
  });

  it("submits compact immediately when selected after keyboard navigation", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      hasSentUserMessage: true,
      draftPrompt: "/",
      availableCommands: [
        { name: "web", description: "Search the web" },
        { name: "compact", description: "summarize conversation" }
      ]
    });
    renderAgentGUINode();

    const editor = getComposerEditor();
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(mockSubmitPrompt).toHaveBeenCalledWith(promptBlocks("/compact"));
    expect(mockUpdateDraftContent).toHaveBeenCalledWith(createDraft(""));
  });

  it("shows Codex fallback slash commands when ACP has not advertised commands", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      hasSentUserMessage: true,
      draftPrompt: "/",
      availableCommands: []
    });
    renderAgentGUINode();

    expect(screen.getByText("compact")).toBeTruthy();
    expect(screen.getByText("status")).toBeTruthy();
    // Plan rides as a local slash command when the capability is negotiated.
    expect(screen.getByText("plan")).toBeTruthy();

    fireEvent.keyDown(getComposerEditor(), { key: "Enter" });

    expect(mockSubmitPrompt).toHaveBeenCalledWith(promptBlocks("/compact"));
    expect(mockUpdateDraftContent).toHaveBeenCalledWith(createDraft(""));
  });

  it("shows OpenCode review from the adapter-owned fallback command", () => {
    const opencodeTarget = createLocalAgentGUIProviderTarget("opencode");
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      data: {
        provider: "opencode",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      selectedProviderTarget: opencodeTarget,
      providerTargets: [opencodeTarget],
      draftPrompt: "/rev",
      availableCommands: []
    });
    renderAgentGUINode();

    expect(screen.getByText("review")).toBeTruthy();
  });

  it("shows OpenCode review when the provider advertises it", () => {
    const opencodeTarget = createLocalAgentGUIProviderTarget("opencode");
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      data: {
        provider: "opencode",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      selectedProviderTarget: opencodeTarget,
      providerTargets: [opencodeTarget],
      draftPrompt: "/rev",
      availableCommands: [{ name: "review", description: "Review changes" }]
    });
    renderAgentGUINode();

    expect(screen.getByText("review")).toBeTruthy();
  });

  it("opens the OpenCode review picker from slash command selection", () => {
    const opencodeTarget = createLocalAgentGUIProviderTarget("opencode");
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      data: {
        provider: "opencode",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      selectedProviderTarget: opencodeTarget,
      providerTargets: [opencodeTarget],
      draftPrompt: "/rev",
      availableCommands: [{ name: "review", description: "Review changes" }]
    });
    renderAgentGUINode();

    fireEvent.keyDown(getComposerEditor(), { key: "Enter" });

    expect(screen.getByTestId("agent-gui-review-picker-panel")).toBeTruthy();
    expect(mockUpdateDraftContent).not.toHaveBeenCalledWith(
      createDraft("/review ")
    );
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
  });

  it("hides compact in an empty conversation", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      hasSentUserMessage: false,
      draftPrompt: "/",
      availableCommands: [{ name: "compact", description: "Compact context" }]
    });
    renderAgentGUINode();

    expect(screen.queryByText("compact")).toBeNull();
    expect(screen.getByText("status")).toBeTruthy();
    expect(screen.getByText("plan")).toBeTruthy();
  });

  it("handles Codex status as a local slash command without submitting", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/sta",
      availableCommands: []
    });
    renderAgentGUINode();

    fireEvent.keyDown(getComposerEditor(), { key: "Enter" });

    expect(mockSubmitPrompt).not.toHaveBeenCalled();
    expect(mockUpdateComposerSettings).not.toHaveBeenCalled();
    expect(mockUpdateDraftContent).toHaveBeenCalledWith(createDraft(""));
  });

  it("exposes /plan in the palette when plan mode is supported", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/pla",
      availableCommands: []
    });
    renderAgentGUINode();

    expect(screen.getByText("plan")).toBeTruthy();
  });

  it("toggles plan mode on manual Codex /plan text instead of submitting", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/plan refactor auth",
      availableCommands: []
    });
    renderAgentGUINode();

    fireEvent.keyDown(getComposerEditor(), { key: "Enter" });

    expect(mockUpdateComposerSettings).toHaveBeenCalledWith({ planMode: true });
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
    expect(mockUpdateDraftContent).toHaveBeenCalledWith(createDraft(""));
  });

  it("toggles plan mode on advertised Claude Code /plan instead of submitting", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      data: {
        provider: "claude-code",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      draftPrompt: "/plan refactor auth",
      availableCommands: [{ name: "plan", description: "provider plan" }]
    });
    renderAgentGUINode();

    fireEvent.keyDown(getComposerEditor(), { key: "Enter" });

    expect(mockUpdateComposerSettings).toHaveBeenCalledWith({ planMode: true });
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
    expect(mockUpdateDraftContent).toHaveBeenCalledWith(createDraft(""));
  });

  it("opens slash commands after leading whitespace at prompt start", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "   /sta",
      availableCommands: []
    });
    renderAgentGUINode();

    expect(
      screen.getByRole("listbox", {
        name: "agentHost.agentGui.slashCommandPalette"
      })
    ).toBeTruthy();
    expect(screen.getByText("status")).toBeTruthy();
  });

  it("reflects slash command selection in the editor before parent draft rerenders", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/",
      availableCommands: [{ name: "web", description: "Search the web" }]
    });
    renderAgentGUINode();

    fireEvent.keyDown(getComposerEditor(), { key: "Enter" });

    expect(mockUpdateDraftContent).toHaveBeenCalledWith(createDraft("/web "));
    await waitFor(() => expect(getComposerEditor()).toHaveTextContent("/web"));
  });

  it("opens slash commands from editor input before parent draft rerenders", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "",
      availableCommands: [{ name: "web", description: "Search the web" }]
    });
    renderAgentGUINode();

    pasteComposerText("/");

    await waitFor(() =>
      expect(mockUpdateDraftContent).toHaveBeenCalledWith(createDraft("/"))
    );
    expect(
      screen.getByRole("listbox", {
        name: "agentHost.agentGui.slashCommandPalette"
      })
    ).toBeTruthy();
  });

  it("dismisses the slash command palette when the node window resize starts", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/",
      availableCommands: [{ name: "web", description: "Search the web" }]
    });
    renderAgentGUINode();

    expect(screen.getByTestId("agent-gui-slash-palette-surface")).toBeTruthy();

    const resizeHandle = screen.getByTestId("agentGui-node-resizer-right");
    resizeHandle.setPointerCapture = vi.fn();

    fireEvent.pointerDown(resizeHandle, {
      button: 0,
      pointerId: 1
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId("agent-gui-slash-palette-surface")
      ).toBeNull();
    });
  });

  it("dismisses the slash command palette when the node window drag starts", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/",
      availableCommands: [{ name: "web", description: "Search the web" }]
    });
    renderAgentGUINode();

    expect(screen.getByTestId("agent-gui-slash-palette-surface")).toBeTruthy();

    fireEvent.pointerDown(
      document.querySelector("[data-node-drag-handle]") as HTMLElement,
      {
        button: 0,
        pointerId: 1
      }
    );

    await waitFor(() => {
      expect(
        screen.queryByTestId("agent-gui-slash-palette-surface")
      ).toBeNull();
    });
  });

  it("supports keyboard navigation in the slash command palette", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/",
      availableCommands: [
        { name: "web", description: "Search the web" },
        { name: "read", description: "Read files" }
      ]
    });
    renderAgentGUINode();

    const editor = getComposerEditor();
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    fireEvent.keyDown(editor, { key: "Tab" });

    expect(mockUpdateDraftContent).toHaveBeenCalledWith(createDraft("/read "));
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
  });

  it("selects slash commands by clicking palette options", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/",
      availableCommands: [
        { name: "web", description: "Search the web" },
        { name: "read", description: "Read files" }
      ]
    });
    renderAgentGUINode();

    fireEvent.click(screen.getByText("read").closest('[role="option"]')!);

    expect(mockUpdateDraftContent).toHaveBeenCalledWith(createDraft("/read "));
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
  });
  it("keeps slash text as a normal prompt after the command token", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/web query",
      availableCommands: [{ name: "web", description: "Search the web" }]
    });
    renderAgentGUINode();

    fireEvent.keyDown(getComposerEditor(), {
      key: "Enter"
    });

    expect(mockSubmitPrompt).toHaveBeenCalledWith(promptBlocks("/web query"));
    expect(mockUpdateDraftContent).toHaveBeenCalledWith(createDraft(""));
  });

  it("does not match slash commands after non-command text", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "hello /re",
      availableCommands: [
        { name: "web", description: "Search the web" },
        { name: "read", description: "Read files" }
      ]
    });
    renderAgentGUINode();

    expect(
      screen.queryByRole("listbox", {
        name: "agentHost.agentGui.slashCommandPalette"
      })
    ).toBeNull();
  });

  it("closes the slash command palette with Escape without changing the draft", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/",
      availableCommands: [{ name: "web", description: "Search the web" }]
    });
    renderAgentGUINode();

    const editor = getComposerEditor();
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(mockUpdateDraftContent).not.toHaveBeenCalled();

    fireEvent.keyDown(editor, { key: "Enter" });

    expect(mockSubmitPrompt).toHaveBeenCalledWith(promptBlocks("/"));
    expect(mockUpdateDraftContent).toHaveBeenCalledWith(createDraft(""));
  });

  it("filters slash commands and closes the palette after the command token", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/re",
      availableCommands: [
        { name: "web", description: "Search the web" },
        { name: "read", description: "Read files" }
      ]
    });
    const rendered = renderAgentGUINode();

    expect(screen.queryByText("web")).toBeNull();
    expect(screen.getByText("read")).toBeTruthy();

    rendered.unmount();
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/read ",
      availableCommands: [{ name: "read", description: "Read files" }]
    });
    renderAgentGUINode();

    expect(
      screen.queryByRole("listbox", {
        name: "agentHost.agentGui.slashCommandPalette"
      })
    ).toBeNull();
  });

  it("inserts Codex skill triggers from the skill picker", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "$ar",
      availableSkills: [
        {
          name: "architecture-review",
          trigger: "$architecture-review",
          sourceKind: "project",
          description: "Review architecture changes"
        }
      ]
    });
    renderAgentGUINode();

    expect(
      screen.getByRole("listbox", {
        name: "agentHost.agentGui.skillPickerPalette"
      })
    ).toBeTruthy();
    expect(screen.getByText("architecture-review")).toBeTruthy();

    fireEvent.keyDown(getComposerEditor(), { key: "Enter" });

    expect(mockUpdateDraftContent).toHaveBeenCalledWith(
      createDraft("$architecture-review ")
    );
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
  });

  it("lets Codex skills use slash aliases and submits provider-native skill triggers", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/ar",
      availableCommands: [{ name: "init", description: "initialize project" }],
      availableSkills: [
        {
          name: "architecture-review",
          trigger: "$architecture-review",
          sourceKind: "project",
          description: "Review architecture changes"
        }
      ]
    });
    renderAgentGUINode();

    expect(
      screen.getByRole("listbox", {
        name: "agentHost.agentGui.slashCommandPalette"
      })
    ).toBeTruthy();
    expect(screen.getByText("architecture-review")).toBeTruthy();

    const editor = getComposerEditor();
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(mockUpdateDraftContent).toHaveBeenCalledWith(
      createDraft("/architecture-review ")
    );
    expect(mockSubmitPrompt).not.toHaveBeenCalled();

    fireEvent.keyDown(editor, { key: "Enter" });
    expect(mockSubmitPrompt).toHaveBeenCalledWith(
      promptBlocks("$architecture-review")
    );
  });

  it("groups slash palette entries into command and skill sections", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/",
      availableCommands: [{ name: "init", description: "initialize project" }],
      availableSkills: [
        {
          name: "architecture-review",
          trigger: "$architecture-review",
          sourceKind: "project",
          description: "Review architecture changes"
        }
      ]
    });
    renderAgentGUINode();

    expect(
      screen.getByText("agentHost.agentGui.slashPaletteCommandsGroup")
    ).toBeTruthy();
    expect(
      screen.getByText("agentHost.agentGui.slashPaletteSkillsGroup")
    ).toBeTruthy();
  });

  it("shows OpenCode skills in the slash palette", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      data: {
        provider: "opencode",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      draftPrompt: "/doc",
      availableCommands: [{ name: "review", description: "Review changes" }],
      availableSkills: [
        {
          name: "docs-update",
          trigger: "/docs-update",
          sourceKind: "project",
          description: "Update documentation"
        }
      ]
    });
    renderAgentGUINode();

    expect(
      screen.getByRole("listbox", {
        name: "agentHost.agentGui.slashCommandPalette"
      })
    ).toBeTruthy();
    expect(screen.getByText("docs-update")).toBeTruthy();

    fireEvent.keyDown(getComposerEditor(), { key: "Enter" });

    expect(mockUpdateDraftContent).toHaveBeenCalledWith(
      createDraft("/docs-update ")
    );
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
  });

  it("groups slash palette plugin and connector entries into separate sections", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/",
      availableCommands: [],
      availableSkills: [
        {
          name: "frontend-design",
          trigger: "$frontend-design",
          sourceKind: "plugin",
          pluginName: "product-design",
          description: "Design product UI"
        },
        {
          name: "Google Drive",
          trigger: "$google-drive",
          sourceKind: "connector",
          kind: "connector",
          description: "Reference files from Drive"
        }
      ]
    });
    renderAgentGUINode();

    expect(
      screen.getByText("agentHost.agentGui.slashPalettePluginsGroup")
    ).toBeTruthy();
    expect(
      screen.getByText("agentHost.agentGui.slashPaletteConnectorsGroup")
    ).toBeTruthy();
    expect(
      screen.queryByText("agentHost.agentGui.slashPaletteSkillsGroup")
    ).toBeNull();
  });

  it("hides slash palette group headers when only one section is present", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/",
      availableCommands: [{ name: "init", description: "initialize project" }],
      availableSkills: []
    });
    renderAgentGUINode();

    expect(
      screen.queryByText("agentHost.agentGui.slashPaletteCommandsGroup")
    ).toBeNull();
    expect(
      screen.queryByText("agentHost.agentGui.slashPaletteSkillsGroup")
    ).toBeNull();
  });

  it("opens Codex skill picker after prompt text and displays useful descriptions", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "please use $ar",
      availableSkills: [
        {
          name: "architecture-review",
          trigger: "$architecture-review",
          sourceKind: "project",
          description: "Review architecture changes\nUse this before coding"
        }
      ]
    });
    renderAgentGUINode();

    expect(
      screen.getByRole("listbox", {
        name: "agentHost.agentGui.skillPickerPalette"
      })
    ).toBeTruthy();
    expect(screen.getByText("Review architecture changes")).toBeTruthy();

    fireEvent.keyDown(getComposerEditor(), { key: "Enter" });

    expect(mockUpdateDraftContent).toHaveBeenCalledWith(
      createDraft("please use $architecture-review ")
    );
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
  });

  it("keeps future Codex slash commands unchanged when submitting", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "/init",
      availableCommands: [{ name: "init", description: "initialize project" }],
      availableSkills: [
        {
          name: "architecture-review",
          trigger: "$architecture-review",
          sourceKind: "project"
        }
      ]
    });
    renderAgentGUINode();

    fireEvent.keyDown(getComposerEditor(), { key: "Enter" });

    expect(mockSubmitPrompt).toHaveBeenCalledWith(promptBlocks("/init"));
  });

  it("inserts Claude Code plugin skill triggers from the slash picker", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      data: {
        provider: "claude-code",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      draftPrompt: "/front",
      availableCommands: [],
      availableSkills: [
        {
          name: "frontend-design",
          trigger: "/product-design:frontend-design",
          sourceKind: "plugin",
          pluginName: "product-design",
          description: "Design product UI"
        }
      ]
    });
    renderAgentGUINode();

    expect(
      screen.getByRole("listbox", {
        name: "agentHost.agentGui.slashCommandPalette"
      })
    ).toBeTruthy();
    expect(screen.getByText("product-design:frontend-design")).toBeTruthy();

    fireEvent.keyDown(getComposerEditor(), { key: "Enter" });

    expect(mockUpdateDraftContent).toHaveBeenCalledWith(
      createDraft("/product-design:frontend-design ")
    );
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
  });

  it("lets Claude Code skills use dollar aliases and submits provider-native skill triggers", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      data: {
        provider: "claude-code",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      draftPrompt: "$front",
      availableCommands: [],
      availableSkills: [
        {
          name: "frontend-design",
          trigger: "/product-design:frontend-design",
          sourceKind: "plugin",
          pluginName: "product-design",
          description: "Design product UI"
        }
      ]
    });
    renderAgentGUINode();

    expect(
      screen.getByRole("listbox", {
        name: "agentHost.agentGui.skillPickerPalette"
      })
    ).toBeTruthy();
    expect(screen.getByText("product-design:frontend-design")).toBeTruthy();

    const editor = getComposerEditor();
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(mockUpdateDraftContent).toHaveBeenCalledWith(
      createDraft("$product-design:frontend-design ")
    );
    expect(mockSubmitPrompt).not.toHaveBeenCalled();

    fireEvent.keyDown(editor, { key: "Enter" });
    expect(mockSubmitPrompt).toHaveBeenCalledWith(
      promptBlocks("/product-design:frontend-design")
    );
  });

  it("opens Claude Code skill picker after prompt text", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      data: {
        provider: "claude-code",
        lastActiveAgentSessionId: null,
        conversationRailWidthPx: null
      },
      draftPrompt: "please use /front",
      availableCommands: [],
      availableSkills: [
        {
          name: "frontend-design",
          trigger: "/product-design:frontend-design",
          sourceKind: "plugin",
          pluginName: "product-design",
          description: "Design product UI"
        }
      ]
    });
    renderAgentGUINode();

    expect(
      screen.getByRole("listbox", {
        name: "agentHost.agentGui.skillPickerPalette"
      })
    ).toBeTruthy();
    expect(screen.getByText("product-design:frontend-design")).toBeTruthy();

    fireEvent.keyDown(getComposerEditor(), { key: "Enter" });

    expect(mockUpdateDraftContent).toHaveBeenCalledWith(
      createDraft("please use /product-design:frontend-design ")
    );
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
  });

  it("searches workspace files and inserts a Markdown file mention", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: ""
    });
    mockSearchWorkspaceFileManagerEntries.mockResolvedValue({
      workspaceId: "room-1",
      root: "/workspace",
      entries: [
        {
          path: "/workspace/docs/README.md",
          name: "README.md",
          kind: "file",
          directoryPath: "/workspace/docs",
          score: 99
        }
      ]
    });
    renderAgentGUINode();

    pasteComposerText("@");
    pasteComposerText("read");
    const palette = await screen.findByRole("listbox", {
      name: "agentHost.agentGui.fileMentionPalette"
    });
    fireEvent.click(within(palette).getByRole("tab", { name: "文件" }));

    await waitFor(() =>
      expect(mockSearchWorkspaceFileManagerEntries).toHaveBeenCalledWith({
        workspaceId: "room-1",
        query: "read",
        limit: 30,
        includeKinds: ["file", "directory"]
      })
    );
    const fileOption = (await within(palette).findByText("README.md")).closest(
      "button"
    );
    expect(fileOption).not.toBeNull();
    await waitFor(() =>
      expect(fileOption).toHaveAttribute("aria-selected", "true")
    );

    fireEvent.keyDown(getComposerEditor(), { key: "Enter" });

    await waitFor(() =>
      expect(mockUpdateDraftContent).toHaveBeenCalledWith(
        createDraft("[@README.md](/workspace/docs/README.md) ")
      )
    );
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
  });

  it("opens the shared workspace reference picker from the reference action", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: ""
    });

    renderAgentGUINode();

    await openSharedWorkspaceReferencePicker();

    expect(
      await screen.findByRole("dialog", {
        name: "agentHost.agentGui.referencePicker.title"
      })
    ).toBeVisible();
    expect(screen.queryByText("agentHost.issue.uploadFile")).toBeNull();
    expect(screen.queryByText("agentHost.issue.uploadFolder")).toBeNull();
  });

  it("reports confirmed workspace references from the shared picker", async () => {
    const onWorkspaceFileReferencesAdded = vi.fn();
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: ""
    });

    renderAgentGUINode({ onWorkspaceFileReferencesAdded });

    await openSharedWorkspaceReferencePicker();
    await screen.findByRole("dialog", {
      name: "agentHost.agentGui.referencePicker.title"
    });
    await waitFor(() =>
      expect(screen.getAllByText("README.md").length).toBeGreaterThan(0)
    );
    const selectReferenceButton = screen
      .getAllByRole("button", { name: "README.md" })
      .find((button) => button.getAttribute("aria-pressed") === "false");
    expect(selectReferenceButton).toBeTruthy();
    fireEvent.click(selectReferenceButton as HTMLElement);
    fireEvent.click(
      screen.getByRole("button", {
        name: "agentHost.agentGui.referencePicker.confirm"
      })
    );

    await waitFor(() =>
      expect(onWorkspaceFileReferencesAdded).toHaveBeenCalledWith({
        provider: "codex",
        references: [
          {
            displayName: "README.md",
            kind: "file",
            path: "/workspace/docs/README.md"
          }
        ]
      })
    );
  });

  it("inserts host-local shared picker selections as uploaded file mention anchors", async () => {
    const uploadPromptContent = vi.fn(async () => ({
      content: [
        {
          type: "file" as const,
          path: "/var/cache/tsh/local-assets/room-1/user-1/home.jpg",
          name: "首页.jpg",
          kind: "file" as const
        }
      ]
    }));
    const hostFile: ReferenceNode = {
      ref: {
        sourceId: "host-local-file",
        nodeId: "host-file-handle-1"
      },
      kind: "file",
      displayName: "首页.jpg"
    };
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "看下 "
    });

    renderAgentGUINode({
      workspaceFileReferenceAdapter: null,
      referenceSourceAggregator: createHostLocalReferenceAggregator(hostFile),
      agentActivityRuntime: {
        uploadPromptContent
      } as unknown as AgentActivityRuntime
    });

    await openSharedWorkspaceReferencePicker();
    await screen.findByRole("dialog", {
      name: "agentHost.agentGui.referencePicker.title"
    });
    const selectReferenceButton = await screen.findByRole("button", {
      name: "首页.jpg"
    });
    fireEvent.click(selectReferenceButton);
    fireEvent.click(
      screen.getByRole("button", {
        name: "agentHost.agentGui.referencePicker.confirm"
      })
    );

    await waitFor(() =>
      expect(uploadPromptContent).toHaveBeenCalledWith({
        workspaceId: "room-1",
        content: [
          {
            type: "file",
            hostPath: "host-file-handle-1",
            name: "首页.jpg",
            kind: "file"
          }
        ]
      })
    );
    await waitFor(() =>
      expect(mockUpdateDraftContent).toHaveBeenCalledWith(
        createDraft(
          "看下 [@首页.jpg](/var/cache/tsh/local-assets/room-1/user-1/home.jpg) "
        )
      )
    );
    expect(
      screen.queryByTestId("agent-gui-composer-file-drafts")
    ).not.toBeInTheDocument();
  });

  it("inserts dropped host-local files into the active conversation draft through upload", async () => {
    const uploadPromptContent = vi.fn(async () => ({
      content: [
        {
          type: "file" as const,
          path: "/var/cache/tsh/local-assets/room-1/user-1/report.pdf",
          name: "report.pdf",
          kind: "file" as const
        }
      ]
    }));
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "看下 "
    });

    renderAgentGUINode({
      agentActivityRuntime: {
        uploadPromptContent
      } as unknown as AgentActivityRuntime,
      resolveDroppedFileReferences: (files) =>
        files.map((file) => ({
          path: "/Users/local/Downloads/report.pdf",
          hostPath: "/Users/local/Downloads/report.pdf",
          displayName: file.name,
          kind: "file",
          sourceId: "host-local-file"
        }))
    });

    const detailPanel = document.querySelector("#agent-gui-detail");
    const dataTransfer = createDataTransferStub([
      new File(["report"], "report.pdf", { type: "application/pdf" })
    ]);

    fireEvent.dragOver(detailPanel!, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("copy");
    fireEvent.drop(detailPanel!, { dataTransfer });

    await waitFor(() =>
      expect(uploadPromptContent).toHaveBeenCalledWith({
        workspaceId: "room-1",
        content: [
          {
            type: "file",
            hostPath: "/Users/local/Downloads/report.pdf",
            name: "report.pdf",
            kind: "file"
          }
        ]
      })
    );
    await waitFor(() =>
      expect(mockUpdateDraftContent).toHaveBeenCalledWith(
        createDraft(
          "看下 [@report.pdf](/var/cache/tsh/local-assets/room-1/user-1/report.pdf) "
        )
      )
    );
  });

  it("uploads host-local files dropped directly into the editor before inserting mentions", async () => {
    const uploadPromptContent = vi.fn(async () => ({
      content: [
        {
          type: "file" as const,
          path: "/var/cache/tsh/local-assets/room-1/user-1/report.pdf",
          name: "report.pdf",
          kind: "file" as const
        }
      ]
    }));
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: ""
    });

    renderAgentGUINode({
      agentActivityRuntime: {
        uploadPromptContent
      } as unknown as AgentActivityRuntime,
      resolveDroppedFileReferences: (files) =>
        files.map((file) => ({
          path: "/Users/local/Downloads/report.pdf",
          hostPath: "/Users/local/Downloads/report.pdf",
          displayName: file.name,
          kind: "file",
          sourceId: "host-local-file"
        }))
    });

    const editor = getComposerEditor();
    const dataTransfer = createDataTransferStub([
      new File(["report"], "report.pdf", { type: "application/pdf" })
    ]);

    fireEvent.dragOver(editor, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("copy");
    fireEvent.drop(editor, {
      dataTransfer,
      clientX: 8,
      clientY: 8
    });

    await waitFor(() =>
      expect(uploadPromptContent).toHaveBeenCalledWith({
        workspaceId: "room-1",
        content: [
          {
            type: "file",
            hostPath: "/Users/local/Downloads/report.pdf",
            name: "report.pdf",
            kind: "file"
          }
        ]
      })
    );
    await waitFor(() =>
      expect(mockUpdateDraftContent).toHaveBeenCalledWith(
        createDraft(
          "[@report.pdf](/var/cache/tsh/local-assets/room-1/user-1/report.pdf) "
        )
      )
    );
    expect(mockUpdateDraftContent).not.toHaveBeenCalledWith(
      createDraft("[@report.pdf](/Users/local/Downloads/report.pdf) ")
    );
  });

  it("opens the shared workspace reference picker with the selected project path revealed", async () => {
    const baseViewModel = createViewModel();
    const loadReferenceTree = vi.fn(
      async (
        input: Parameters<
          NonNullable<WorkspaceFileReferenceAdapter["loadReferenceTree"]>
        >[0]
      ) => ({
        budgetExceeded: false,
        directory: {
          directoryPath: input.path ?? "/Users/example",
          entries: [
            {
              displayName: "demo",
              kind: "folder",
              path: "/Users/example/demo"
            },
            {
              displayName: "project",
              kind: "folder",
              path: "/Users/example/project"
            }
          ],
          prefetchState: "loaded"
        },
        prefetchBudgetMs: 500,
        prefetchDepth: 4,
        rootPath: "/Users/example"
      })
    );
    const listDirectory = vi.fn(
      async (
        input: Parameters<
          NonNullable<WorkspaceFileReferenceAdapter["listDirectory"]>
        >[0]
      ) => ({
        directoryPath: input.path ?? "/Users/example",
        entries:
          input.path === "/Users/example/demo"
            ? [
                {
                  displayName: "README.md",
                  kind: "file",
                  path: "/Users/example/demo/README.md"
                }
              ]
            : [],
        rootPath: "/Users/example"
      })
    );
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "",
      composerSettings: {
        ...baseViewModel.composerSettings,
        selectedProjectPath: "/Users/example/demo"
      }
    });

    renderAgentGUINode({
      workspaceFileReferenceAdapter: { listDirectory, loadReferenceTree }
    });

    await openSharedWorkspaceReferencePicker();

    await waitFor(() =>
      expect(loadReferenceTree).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "room-1"
        })
      )
    );
    expect(loadReferenceTree.mock.calls[0]?.[0].path).toBeUndefined();
    expect(await screen.findByText("project")).toBeVisible();

    await waitFor(() =>
      expect(listDirectory).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/Users/example/demo",
          workspaceId: "room-1"
        })
      )
    );
    expect(await screen.findByText("README.md")).toBeVisible();
  });

  it("shows the file search loading label while workspace results are still loading", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: ""
    });
    type PendingFileSearch = {
      workspaceId: string;
      root: string;
      entries: Array<{
        path: string;
        name: string;
        kind: "file" | "directory";
        directoryPath: string;
        score: number;
      }>;
    };
    let resolveFileSearch!: (value: PendingFileSearch) => void;
    const pendingFileSearch = new Promise<PendingFileSearch>((resolve) => {
      resolveFileSearch = resolve;
    });
    mockSearchWorkspaceFileManagerEntries.mockImplementation((input) =>
      input.query === "read"
        ? pendingFileSearch
        : Promise.resolve({
            workspaceId: "room-1",
            root: "/workspace",
            entries: []
          })
    );
    renderAgentGUINode();

    pasteComposerText("@");
    pasteComposerText("read");
    const palette = await screen.findByRole("listbox", {
      name: "agentHost.agentGui.fileMentionPalette"
    });
    fireEvent.click(within(palette).getByRole("tab", { name: "文件" }));

    await waitFor(() =>
      expect(mockSearchWorkspaceFileManagerEntries).toHaveBeenCalledWith({
        workspaceId: "room-1",
        query: "read",
        limit: 30,
        includeKinds: ["file", "directory"]
      })
    );
    expect(
      within(palette).getByText("agentHost.agentGui.fileMentionLoading")
    ).toBeVisible();
    expect(
      within(palette).queryByTestId("agent-mention-loading-banner")
    ).toBeNull();
    expect(within(palette).queryByText("没有匹配到文件")).toBeNull();

    resolveFileSearch({
      workspaceId: "room-1",
      root: "/workspace",
      entries: [
        {
          path: "/workspace/docs/README.md",
          name: "README.md",
          kind: "file",
          directoryPath: "/workspace/docs",
          score: 99
        }
      ]
    });

    expect(await within(palette).findByText("README.md")).toBeVisible();
  });
  it("supports arrow navigation in the empty-state session mention palette", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: ""
    });
    renderAgentGUINode();

    pasteComposerText("@");

    const palette = await screen.findByRole("listbox", {
      name: "agentHost.agentGui.fileMentionPalette"
    });
    const sessionOption = within(palette).getByRole("tab", { name: "会话" });
    const fileOption = within(palette).getByRole("tab", { name: "文件" });

    expect(within(palette).queryByRole("tab", { name: "全部" })).toBeNull();
    expect(sessionOption).toHaveAttribute("aria-selected", "true");
    expect(fileOption).toHaveAttribute("aria-selected", "false");
    expect(
      within(palette).queryByText("根据你输入的内容搜索工作区文件")
    ).toBeNull();
    expect(await within(palette).findByText("暂无会话")).toBeVisible();
    expect(within(palette).queryByText("暂无协作会话")).toBeNull();
    expect(within(palette).queryByRole("tab", { name: "协作" })).toBeNull();
    expect(within(palette).queryByText("No tasks yet")).toBeNull();

    fireEvent.keyDown(getComposerEditor(), { key: "ArrowDown" });

    expect(sessionOption).toHaveAttribute("aria-selected", "true");
    expect(fileOption).toHaveAttribute("aria-selected", "false");
    expect(
      within(palette).queryByText("根据你输入的内容搜索工作区文件")
    ).toBeNull();
  });
  it("cycles mention tabs from session through file, issue, agent, and app", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: ""
    });
    renderAgentGUINode();

    pasteComposerText("@");

    const palette = await screen.findByRole("listbox", {
      name: "agentHost.agentGui.fileMentionPalette"
    });
    const expectSelectedTab = async (name: string) => {
      await waitFor(() =>
        expect(within(palette).getByRole("tab", { name })).toHaveAttribute(
          "aria-selected",
          "true"
        )
      );
    };

    expect(within(palette).queryByRole("tab", { name: "全部" })).toBeNull();
    await expectSelectedTab("会话");

    fireEvent.keyDown(getComposerEditor(), { key: "Tab" });
    await expectSelectedTab("文件");

    fireEvent.keyDown(getComposerEditor(), { key: "Tab" });
    await expectSelectedTab("Tasks");

    fireEvent.keyDown(getComposerEditor(), { key: "Tab" });
    await expectSelectedTab("Agent");

    fireEvent.keyDown(getComposerEditor(), { key: "Tab" });
    await expectSelectedTab("App");

    fireEvent.keyDown(getComposerEditor(), { key: "Tab" });
    await expectSelectedTab("会话");
  });

  it("loads app mentions when selecting the app tab with an empty query", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: ""
    });
    mockListWorkspaceApps.mockResolvedValue({
      apps: [
        {
          appId: "vibe-design",
          description: "Design prototypes in Tutti.",
          iconUrl: "tutti://workspace-apps/vibe-design/icon.png",
          name: "Vibe Design",
          workspaceId: "room-1"
        }
      ]
    });
    renderAgentGUINode();

    pasteComposerText("@");

    const palette = await screen.findByRole("listbox", {
      name: "agentHost.agentGui.fileMentionPalette"
    });
    await within(palette).findByText("暂无会话");
    fireEvent.click(within(palette).getByRole("tab", { name: "App" }));

    await waitFor(() =>
      expect(mockListWorkspaceApps).toHaveBeenCalledWith({
        workspaceId: "room-1",
        query: "",
        limit: undefined
      })
    );
    expect(within(palette).getByRole("tab", { name: "App" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(await within(palette).findByText("Vibe Design")).toBeVisible();
    expect(mockSearchWorkspaceFileManagerEntries).not.toHaveBeenCalled();
    expect(mockListWorkspaceIssues).not.toHaveBeenCalled();
  });

  it("keeps the default browse tab scoped to sessions", async () => {
    mockListWorkspaceIssues.mockResolvedValue({
      issues: [],
      totalCount: 0,
      statusCounts: undefined
    });
    mockListWorkspaceAgents.mockResolvedValue({
      presences: [],
      sessions: []
    });
    mockBatchGetUserInfo.mockResolvedValue({ users: [] });
    renderAgentGUINode();

    pasteComposerText("@");

    const palette = await screen.findByRole("listbox", {
      name: "agentHost.agentGui.fileMentionPalette"
    });

    expect(within(palette).getByRole("tab", { name: "会话" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(within(palette).queryByRole("tab", { name: "全部" })).toBeNull();
    expect(await within(palette).findByText("暂无会话")).toBeVisible();
    expect(
      within(palette).queryByText("根据你输入的内容搜索工作区文件")
    ).toBeNull();
    expect(within(palette).getByText("我的会话")).toBeVisible();
    expect(within(palette).queryByText("协作会话")).toBeNull();
    expect(within(palette).queryByText("暂无协作会话")).toBeNull();
    expect(within(palette).getByRole("tab", { name: "Tasks" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
    expect(within(palette).queryByText("No tasks yet")).toBeNull();
    expect(mockListWorkspaceAgents).toHaveBeenCalledTimes(1);
    expect(mockSearchWorkspaceFileManagerEntries).not.toHaveBeenCalled();
    expect(mockListWorkspaceIssues).not.toHaveBeenCalled();
  });

  it("shows the loading label when opening @ mentions before any browse data is ready", async () => {
    type EmptyAgentLoad = {
      presences: [];
      sessions: [];
    };
    let resolveAgentLoad!: (value: EmptyAgentLoad) => void;
    const pendingAgentLoad = new Promise<EmptyAgentLoad>((resolve) => {
      resolveAgentLoad = resolve;
    });
    mockListWorkspaceAgents.mockImplementationOnce(() => pendingAgentLoad);
    renderAgentGUINode();

    pasteComposerText("@");

    await waitFor(() =>
      expect(mockListWorkspaceAgents).toHaveBeenCalledTimes(1)
    );
    expect(mockListWorkspaceIssues).not.toHaveBeenCalled();

    const palette = await screen.findByRole("listbox", {
      name: "agentHost.agentGui.fileMentionPalette"
    });

    expect(
      within(palette).getByText("agentHost.agentGui.fileMentionLoading")
    ).toBeVisible();
    expect(
      within(palette).queryByTestId("agent-mention-loading-banner")
    ).toBeNull();
    expect(
      within(palette).queryByText("根据你输入的内容搜索工作区文件")
    ).toBeNull();

    resolveAgentLoad({
      presences: [],
      sessions: []
    });
  });

  it("dismisses the file mention palette when the node window resize starts", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: ""
    });
    renderAgentGUINode();

    pasteComposerText("@");

    await screen.findByTestId("agent-gui-mention-palette-surface");

    const resizeHandle = screen.getByTestId("agentGui-node-resizer-right");
    resizeHandle.setPointerCapture = vi.fn();

    fireEvent.pointerDown(resizeHandle, {
      button: 0,
      pointerId: 1
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId("agent-gui-mention-palette-surface")
      ).toBeNull();
    });
  });

  it("dismisses the file mention palette when the node window drag starts", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: ""
    });
    renderAgentGUINode();

    pasteComposerText("@");

    await screen.findByTestId("agent-gui-mention-palette-surface");

    fireEvent.pointerDown(
      document.querySelector("[data-node-drag-handle]") as HTMLElement,
      {
        button: 0,
        pointerId: 1
      }
    );

    await waitFor(() => {
      expect(
        screen.queryByTestId("agent-gui-mention-palette-surface")
      ).toBeNull();
    });
  });

  it("keeps arrow navigation inside browse results and reserves Tab for category switching", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: ""
    });
    mockListWorkspaceIssues.mockResolvedValue({
      issues: [
        {
          issueId: "issue-1",
          workspaceId: "room-1",
          title: "修复 room status",
          content: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "补齐 statusBatch 的错误处理" }]
              }
            ]
          }),
          status: "running",
          creatorUserId: "user-2",
          creatorDisplayName: "Alice",
          issueCount: 0,
          notStartedCount: 0,
          runningCount: 0,
          pendingAcceptanceCount: 0,
          completedCount: 0,
          failedCount: 0,
          canceledCount: 0,
          updatedAtUnix: 20
        },
        {
          issueId: "issue-2",
          workspaceId: "room-1",
          title: "整理 agent 输入",
          content: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "确认上下键和 Tab 的职责边界" }]
              }
            ]
          }),
          status: "not_started",
          creatorUserId: "user-3",
          creatorDisplayName: "Bob",
          issueCount: 0,
          notStartedCount: 0,
          runningCount: 0,
          pendingAcceptanceCount: 0,
          completedCount: 0,
          failedCount: 0,
          canceledCount: 0,
          updatedAtUnix: 10
        }
      ],
      totalCount: 2,
      statusCounts: undefined
    });
    renderAgentGUINode();

    pasteComposerText("@");

    const palette = await screen.findByRole("listbox", {
      name: "agentHost.agentGui.fileMentionPalette"
    });
    fireEvent.click(within(palette).getByRole("tab", { name: "Tasks" }));

    await waitFor(() =>
      expect(mockListWorkspaceIssues).toHaveBeenCalledWith({
        workspaceId: "room-1",
        pageSize: 25,
        searchQuery: ""
      })
    );
    const firstTaskOption = (
      await screen.findByText("修复 room status")
    ).closest("button");
    const secondTaskOption = (
      await screen.findByText("整理 agent 输入")
    ).closest("button");
    const taskOption = within(palette).getByRole("tab", { name: "Tasks" });
    const sessionOption = within(palette).getByRole("tab", { name: "会话" });
    const agentOption = within(palette).getByRole("tab", { name: "Agent" });

    expect(
      within(firstTaskOption as HTMLButtonElement).getByText("执行中")
    ).toBeTruthy();
    expect(
      within(secondTaskOption as HTMLButtonElement).getByText("待开始")
    ).toBeTruthy();
    expect(within(palette).queryByText("已退出")).toBeNull();
    expect(firstTaskOption).toHaveAttribute("aria-selected", "true");
    expect(taskOption).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(getComposerEditor(), { key: "ArrowDown" });

    expect(firstTaskOption).toHaveAttribute("aria-selected", "false");
    expect(secondTaskOption).toHaveAttribute("aria-selected", "true");
    expect(taskOption).toHaveAttribute("aria-selected", "true");
    expect(sessionOption).toHaveAttribute("aria-selected", "false");
    expect(within(palette).queryByRole("tab", { name: "全部" })).toBeNull();

    fireEvent.keyDown(getComposerEditor(), { key: "Tab" });

    await waitFor(() => {
      expect(
        within(palette).getByRole("tab", { name: "Tasks" })
      ).toHaveAttribute("aria-selected", "false");
      expect(
        within(palette).getByRole("tab", { name: "Agent" })
      ).toHaveAttribute("aria-selected", "true");
      expect(
        within(palette).getByRole("tab", { name: "会话" })
      ).toHaveAttribute("aria-selected", "false");
    });
    expect(agentOption).toHaveAttribute("aria-selected", "true");
  });
  it("uses the message-derived title in the @ session list when summary titles are empty", async () => {
    mockViewModel = createViewModel({ currentUserId: "user-1" });
    mockListWorkspaceAgents.mockResolvedValue({
      presences: [],
      sessions: [
        {
          agentSessionId: "019e4dd9-20f7-7b92-9b18-a4eb49b57127",
          workspaceId: "room-1",
          userId: "user-1",
          provider: "codex",
          title: "",
          effectiveStatus: "idle",
          createdAtUnixMs: 1,
          updatedAtUnixMs: 20
        }
      ]
    });
    mockBatchGetUserInfo.mockResolvedValue({
      users: [
        {
          userId: "user-1",
          name: "wang jomes",
          avatar: "https://cdn.example.com/wang.png"
        }
      ]
    });
    mockGetWorkspaceAgentSessionSummary.mockResolvedValue({
      workspaceId: "room-1",
      agentSessionId: "019e4dd9-20f7-7b92-9b18-a4eb49b57127",
      executionStatus: "COMPLETED",
      latestUserRequirement: "",
      recentAgentReplies: [],
      initialUserRequirement: "",
      initialTurn: null,
      latestTurn: null,
      recentTurns: []
    });
    mockListWorkspaceAgentSessionMessages.mockResolvedValue({
      messages: [
        {
          id: 1,
          agentSessionId: "019e4dd9-20f7-7b92-9b18-a4eb49b57127",
          messageId: "user-1",
          version: 1,
          turnId: "turn-1",
          role: "user",
          kind: "text",
          payload: { text: "hi" },
          occurredAtUnixMs: 10
        }
      ],
      latestVersion: 1,
      hasMore: false
    });
    renderAgentGUINode();

    pasteComposerText("@");
    await waitFor(() =>
      expect(mockListWorkspaceAgents).toHaveBeenCalledWith({
        workspaceId: "room-1",
        sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
      })
    );

    const mySessionOption = (await screen.findByText("hi")).closest("button");
    expect(mySessionOption).not.toBeNull();
    expect(
      within(mySessionOption as HTMLElement).getByText("hi")
    ).toBeVisible();
    expect(mySessionOption).not.toHaveTextContent(
      "019e4dd9-20f7-7b92-9b18-a4eb49b57127"
    );

    await waitFor(() =>
      expect(mockListWorkspaceAgentSessionMessages).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "019e4dd9-20f7-7b92-9b18-a4eb49b57127",
        afterVersion: 0,
        limit: 20
      })
    );
  });
  it("updates the draft when a workspace entry is dropped into the composer", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: ""
    });
    const rendered = renderAgentGUINode();

    const dataTransfer = createDataTransferStub();
    writeWorkspaceFileDropData(dataTransfer, [
      {
        path: "/workspace/docs/README.md",
        name: "README.md",
        kind: "file"
      }
    ]);

    fireEvent.drop(getComposerEditor(), {
      dataTransfer,
      clientX: 12,
      clientY: 12
    });

    await waitFor(() =>
      expect(mockUpdateDraftContent).toHaveBeenCalledWith(
        createDraft("[@README.md](/workspace/docs/README.md) ")
      )
    );
    expect(mockSubmitPrompt).not.toHaveBeenCalled();

    rendered.unmount();
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "[@README.md](/workspace/docs/README.md) "
    });
    renderAgentGUINode();
    fireEvent.click(
      screen.getByRole("button", { name: "agentHost.agentGui.send" })
    );

    expect(mockSubmitPrompt).toHaveBeenCalledWith(
      promptBlocks("[@README.md](/workspace/docs/README.md)")
    );
  });

  it("updates the draft with multiple dropped workspace entries in order", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: ""
    });
    renderAgentGUINode();

    const dataTransfer = createDataTransferStub();
    writeWorkspaceFileDropData(dataTransfer, [
      {
        path: "/workspace/docs/README.md",
        name: "README.md",
        kind: "file"
      },
      {
        path: "/workspace/src",
        name: "src",
        kind: "directory"
      }
    ]);

    fireEvent.drop(getComposerEditor(), {
      dataTransfer,
      clientX: 12,
      clientY: 12
    });

    await waitFor(() =>
      expect(mockUpdateDraftContent).toHaveBeenCalledWith(
        createDraft(
          "[@README.md](/workspace/docs/README.md) [@src](/workspace/src) "
        )
      )
    );
  });

  it("does not search workspace files for email-style at signs", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: ""
    });
    renderAgentGUINode();

    pasteComposerText("a@b.com");

    await waitFor(() =>
      expect(getComposerEditor()).toHaveTextContent("a@b.com")
    );
    expect(mockSearchWorkspaceFileManagerEntries).not.toHaveBeenCalledWith(
      expect.objectContaining({
        query: "b.com"
      })
    );
    expect(
      screen.queryByRole("listbox", {
        name: "agentHost.agentGui.fileMentionPalette"
      })
    ).toBeNull();
  });

  it("does not open the mention panel after pasting a complete at query", async () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: ""
    });
    renderAgentGUINode();

    pasteComposerText("@read");

    await waitFor(() => expect(getComposerEditor()).toHaveTextContent("@read"));
    expect(mockSearchWorkspaceFileManagerEntries).not.toHaveBeenCalledWith(
      expect.objectContaining({
        query: "read"
      })
    );
    expect(
      screen.queryByRole("listbox", {
        name: "agentHost.agentGui.fileMentionPalette"
      })
    ).toBeNull();
  });

  it("renders the shared transcript view without the removed runtime context chrome", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      conversationDetail: detailViewModel(),
      sessionChrome: {
        auth: null,
        approval: null,
        recovery: null,
        rawState: null
      }
    });
    renderAgentGUINode();

    expect(screen.getByText("Please inspect this")).toBeTruthy();
    expect(screen.getByText("I will check it.")).toBeTruthy();
    expect(screen.getByText("Read file")).toBeTruthy();
  });

  it("preserves manual timeline scroll while the active conversation streams output", () => {
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight"
    );
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight"
    );
    const originalScrollTop = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollTop"
    );
    let timelineScrollHeight = 520;
    let timelineScrollTop = 0;

    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        if (this.getAttribute("data-testid") === "agent-gui-timeline") {
          return 120;
        }
        return originalClientHeight?.get?.call(this) ?? 0;
      }
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        if (this.getAttribute("data-testid") === "agent-gui-timeline") {
          return timelineScrollHeight;
        }
        return originalScrollHeight?.get?.call(this) ?? 0;
      }
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        if (this.getAttribute("data-testid") === "agent-gui-timeline") {
          return timelineScrollTop;
        }
        return originalScrollTop?.get?.call(this) ?? 0;
      },
      set(value: number) {
        if (this.getAttribute("data-testid") === "agent-gui-timeline") {
          timelineScrollTop = Number(value);
          return;
        }
        originalScrollTop?.set?.call(this, value);
      }
    });

    const renderNode = (): React.ReactElement => (
      <AgentGUINode
        nodeId="agent-gui-1"
        workspaceId="room-1"
        currentUserId="user-1"
        workspacePath="/workspace"
        agentSettings={{ avoidGroupingEdits: false }}
        title="Codex"
        state={{
          provider: "codex",
          lastActiveAgentSessionId: null,
          conversationRailWidthPx: null
        }}
        position={{ x: 0, y: 0 }}
        width={720}
        height={560}
        desktopSize={{ width: 1200, height: 800 }}
        isActive={true}
        onClose={vi.fn()}
        onResize={vi.fn()}
        onUpdateNode={vi.fn()}
      />
    );

    try {
      const detail = detailViewModel();
      mockViewModel = createViewModel({
        activeConversationId: "session-1",
        conversationDetail: detail
      });

      const renderResult = render(renderNode());
      const timeline = screen.getByTestId("agent-gui-timeline");
      expect(timelineScrollTop).toBe(400);

      timelineScrollTop = 40;
      fireEvent.scroll(timeline);
      timelineScrollHeight = 620;

      const turn = detail.turns[0]!;
      mockViewModel = createViewModel({
        activeConversationId: "session-1",
        conversationDetail: {
          ...detail,
          turns: [
            {
              ...turn,
              agentMessages: [
                ...turn.agentMessages,
                { id: "assistant-2", body: "Streaming update" }
              ],
              agentItems: [
                ...turn.agentItems,
                {
                  kind: "message",
                  message: { id: "assistant-2", body: "Streaming update" }
                }
              ]
            }
          ]
        }
      });

      renderResult.rerender(renderNode());

      expect(screen.getByText("Streaming update")).toBeTruthy();
      expect(timelineScrollTop).toBe(40);
    } finally {
      if (originalClientHeight) {
        Object.defineProperty(
          HTMLElement.prototype,
          "clientHeight",
          originalClientHeight
        );
      }
      if (originalScrollHeight) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollHeight",
          originalScrollHeight
        );
      }
      if (originalScrollTop) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollTop",
          originalScrollTop
        );
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTop;
      }
    }
  });

  it("sticks the timeline to the bottom without smooth scrolling while output streams", () => {
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight"
    );
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight"
    );
    const originalScrollTop = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollTop"
    );
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    let timelineScrollHeight = 520;
    let timelineScrollTop = 0;
    const scrollToSpy = vi.fn(function scrollToMock(
      this: HTMLElement,
      leftOrOptions?: number | ScrollToOptions,
      top?: number
    ) {
      if (this.getAttribute("data-testid") !== "agent-gui-timeline") {
        return;
      }
      if (typeof leftOrOptions === "number") {
        timelineScrollTop = Number(top ?? 0);
        return;
      }
      timelineScrollTop = Number(leftOrOptions?.top ?? 0);
    });

    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        if (this.getAttribute("data-testid") === "agent-gui-timeline") {
          return 120;
        }
        return originalClientHeight?.get?.call(this) ?? 0;
      }
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        if (this.getAttribute("data-testid") === "agent-gui-timeline") {
          return timelineScrollHeight;
        }
        return originalScrollHeight?.get?.call(this) ?? 0;
      }
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        if (this.getAttribute("data-testid") === "agent-gui-timeline") {
          return timelineScrollTop;
        }
        return originalScrollTop?.get?.call(this) ?? 0;
      },
      set(value: number) {
        if (this.getAttribute("data-testid") === "agent-gui-timeline") {
          timelineScrollTop = Number(value);
          return;
        }
        originalScrollTop?.set?.call(this, value);
      }
    });
    HTMLElement.prototype.scrollTo =
      scrollToSpy as typeof HTMLElement.prototype.scrollTo;

    try {
      const detail = detailViewModel();
      mockViewModel = createViewModel({
        activeConversationId: "session-1",
        conversationDetail: detail
      });

      const renderResult = renderAgentGUINode();
      expect(timelineScrollTop).toBe(400);

      timelineScrollHeight = 620;
      const turn = detail.turns[0]!;
      mockViewModel = createViewModel({
        activeConversationId: "session-1",
        conversationDetail: {
          ...detail,
          turns: [
            {
              ...turn,
              agentMessages: [
                ...turn.agentMessages,
                { id: "assistant-2", body: "Streaming update" }
              ],
              agentItems: [
                ...turn.agentItems,
                {
                  kind: "message",
                  message: { id: "assistant-2", body: "Streaming update" }
                }
              ]
            }
          ]
        }
      });

      renderResult.rerender(
        <AgentGUINode
          nodeId="agent-gui-1"
          workspaceId="room-1"
          currentUserId="user-1"
          workspacePath="/workspace"
          agentSettings={{ avoidGroupingEdits: false }}
          title="Codex"
          state={{
            provider: "codex",
            lastActiveAgentSessionId: null,
            conversationRailWidthPx: null
          }}
          position={{ x: 0, y: 0 }}
          width={720}
          height={560}
          desktopSize={{ width: 1200, height: 800 }}
          isActive={true}
          onClose={vi.fn()}
          onResize={vi.fn()}
          onUpdateNode={vi.fn()}
        />
      );

      expect(screen.getByText("Streaming update")).toBeTruthy();
      expect(timelineScrollTop).toBe(500);
      expect(scrollToSpy).not.toHaveBeenCalled();
    } finally {
      HTMLElement.prototype.scrollTo = originalScrollTo;
      if (originalClientHeight) {
        Object.defineProperty(
          HTMLElement.prototype,
          "clientHeight",
          originalClientHeight
        );
      }
      if (originalScrollHeight) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollHeight",
          originalScrollHeight
        );
      }
      if (originalScrollTop) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollTop",
          originalScrollTop
        );
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTop;
      }
    }
  });

  it("deduplicates inline notices already shown by session chrome", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      conversationDetail: detailViewModel(),
      inlineNotice: {
        id: "notice-1",
        message: "Something went wrong. Please try again.",
        tone: "error",
        autoDismissMs: null
      },
      sessionChrome: {
        auth: null,
        approval: null,
        recovery: {
          kind: "failed",
          message: "Something went wrong. Please try again."
        },
        rawState: null
      }
    });
    renderAgentGUINode();

    expect(
      screen.getAllByText("Something went wrong. Please try again.")
    ).toHaveLength(1);
    expect(
      within(screen.getByTestId("agent-gui-bottom-dock")).getByText(
        "Something went wrong. Please try again."
      )
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "agentHost.agentGui.retryActivation"
      })
    ).toBeTruthy();
  });

  it("renders inline error notices through the composer error chrome", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      conversationDetail: detailViewModel(),
      inlineNotice: {
        id: "notice-1",
        message: "Something went wrong. Please try again.",
        tone: "error",
        autoDismissMs: null
      },
      sessionChrome: {
        auth: null,
        approval: null,
        recovery: null,
        rawState: null
      }
    });
    renderAgentGUINode();

    expect(screen.queryByTestId("agent-gui-detail-error-toast")).toBeNull();
    const errorChrome = within(
      screen.getByTestId("agent-gui-bottom-dock")
    ).getByRole("alert");
    expect(errorChrome.textContent).toContain(
      "Something went wrong. Please try again."
    );
    expect(errorChrome.className).toContain("agent-gui-chrome__card--danger");
    expect(
      within(screen.getByTestId("agent-gui-bottom-dock")).queryByRole(
        "button",
        {
          name: "agentHost.agentGui.retryActivation"
        }
      )
    ).toBeNull();
  });

  it("renders new-conversation-only model inline notices with danger color", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      conversationDetail: detailViewModel(),
      inlineNotice: {
        id: "notice-1",
        message:
          "This model can only be used in a new session to preserve context.",
        tone: "warning",
        autoDismissMs: 2_000
      },
      sessionChrome: {
        auth: null,
        approval: null,
        recovery: null,
        rawState: null
      }
    });
    renderAgentGUINode();

    expect(screen.queryByTestId("agent-gui-detail-error-toast")).toBeNull();
    const warningChrome = within(screen.getByTestId("agent-gui-bottom-dock"))
      .getByText(
        "This model can only be used in a new session to preserve context."
      )
      .closest("section");
    expect(warningChrome).not.toBeNull();
    expect(warningChrome?.className).toContain(
      "agent-gui-chrome__card--danger"
    );
    expect(warningChrome?.className).not.toContain(
      "agent-gui-chrome__card--warning"
    );
    expect(
      within(screen.getByTestId("agent-gui-bottom-dock")).queryByRole("alert")
    ).toBeNull();
  });

  it("suppresses context canceled inline chrome after an interrupted conversation has completed", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      conversations: [
        {
          id: "session-1",
          provider: "codex",
          title: "Codex",
          status: "completed",
          cwd: "/workspace",
          updatedAtUnixMs: 1
        }
      ],
      activeConversation: {
        id: "session-1",
        provider: "codex",
        title: "Codex",
        status: "completed",
        cwd: "/workspace",
        updatedAtUnixMs: 1
      },
      conversationDetail: detailViewModel(),
      inlineNotice: {
        id: "notice-1",
        message: "context canceled",
        tone: "error",
        autoDismissMs: null
      },
      activeLiveState: "active",
      sessionChrome: {
        auth: null,
        approval: null,
        recovery: null,
        rawState: null
      }
    });
    renderAgentGUINode();

    expect(screen.queryByText("context canceled")).toBeNull();
    expect(
      within(screen.getByTestId("agent-gui-bottom-dock")).queryByRole("alert")
    ).toBeNull();
  });

  it("keeps the composer editor enabled while auth warning chrome is visible", () => {
    const onAgentProviderLogin = vi.fn();
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      conversationDetail: detailViewModel(),
      canSubmit: false,
      sessionChrome: {
        auth: {
          message: "Unauthorized request."
        },
        approval: null,
        recovery: null,
        rawState: null
      }
    });
    renderAgentGUINode({ onAgentProviderLogin });

    expect(screen.getByText("Unauthorized request.")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "agentHost.agentGui.authLogin" })
    );
    expect(onAgentProviderLogin).toHaveBeenCalledWith("codex");
    expect(getComposerEditor()).not.toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("button", { name: "agentHost.agentGui.send" })
    ).toBeDisabled();
  });

  it("disables the composer editor when session recovery fails without retry", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      conversationDetail: detailViewModel(),
      draftPrompt: "continue this session",
      canSubmit: false,
      sessionChrome: {
        auth: null,
        approval: null,
        recovery: {
          kind: "failed",
          message:
            "This session cannot be resumed on this device. Start a new session and @this session to keep going.",
          canRetry: false
        },
        rawState: null
      }
    });
    renderAgentGUINode();

    expect(getComposerEditor()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This session cannot be resumed on this device. Start a new session and @this session to keep going."
    );
  });

  it("shows a continue-in-new-session action for non-local recovery failures", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      conversationDetail: detailViewModel(),
      sessionChrome: {
        auth: null,
        approval: null,
        recovery: {
          kind: "failed",
          message:
            "This session cannot be resumed on this device. Start a new session and @this session to keep going.",
          canRetry: false,
          followupAction: "continue-in-new-conversation"
        },
        rawState: null
      }
    });
    renderAgentGUINode();

    fireEvent.click(
      screen.getByRole("button", {
        name: "agentHost.agentGui.continueInNewConversation"
      })
    );

    expect(mockContinueInNewConversation).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", {
        name: "agentHost.agentGui.retryActivation"
      })
    ).toBeNull();
  });

  it("lifts the active prompt above inline notice chrome in the bottom dock", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      conversationDetail: detailViewModel(),
      inlineNotice: {
        id: "notice-1",
        message: "Something went wrong. Please try again.",
        tone: "error",
        autoDismissMs: null
      },
      pendingApproval: approvalRequest(),
      sessionChrome: {
        auth: null,
        approval: approvalRequest(),
        recovery: null,
        rawState: null
      }
    });
    renderAgentGUINode();

    const bottomDock = screen.getByTestId("agent-gui-bottom-dock");
    const liftedPrompt = within(bottomDock).getByTestId(
      "agent-gui-bottom-dock-active-prompt"
    );
    const errorChrome = within(bottomDock).getByRole("alert");
    const composer = getComposerEditor().closest("form");

    expect(liftedPrompt.compareDocumentPosition(errorChrome)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(composer).not.toBeNull();
    expect(
      within(composer as HTMLFormElement).queryByTestId(
        "agent-gui-composer-floating-prompt"
      )
    ).toBeNull();

    fireEvent.click(
      within(liftedPrompt).getByRole("button", { name: "Yes, proceed" })
    );

    expect(mockSubmitInteractivePrompt).toHaveBeenCalledWith({
      requestId: "request-1",
      optionId: "allow_once"
    });
    expect(
      screen.queryByTestId("agent-gui-bottom-dock-active-prompt")
    ).toBeNull();
  });

  it("does not use bottom dock approval prompt keyboard shortcuts while the node is inactive", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      conversationDetail: detailViewModel(),
      draftPrompt: "should not submit",
      inlineNotice: {
        id: "notice-1",
        message: "Something went wrong. Please try again.",
        tone: "error",
        autoDismissMs: null
      },
      pendingApproval: approvalRequest(),
      sessionChrome: {
        auth: null,
        approval: approvalRequest(),
        recovery: null,
        rawState: null
      }
    });
    renderAgentGUINode({ isActive: false });

    const bottomDock = screen.getByTestId("agent-gui-bottom-dock");
    expect(
      within(bottomDock).getByTestId("agent-gui-bottom-dock-active-prompt")
    ).toBeTruthy();

    fireEvent.keyDown(window, { key: "Enter" });

    expect(mockSubmitInteractivePrompt).not.toHaveBeenCalled();
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
    expect(
      within(bottomDock).queryByTestId("agent-gui-bottom-dock-active-prompt")
    ).toBeTruthy();
  });

  it("renders inline error notices above the hero composer before a conversation starts", () => {
    mockViewModel = createViewModel({
      activeConversationId: null,
      conversationDetail: null,
      inlineNotice: {
        id: "notice-1",
        message: "Something went wrong. Please try again.",
        tone: "error",
        autoDismissMs: null
      },
      sessionChrome: {
        auth: null,
        approval: null,
        recovery: null,
        rawState: null
      }
    });
    renderAgentGUINode();

    expect(screen.queryByTestId("agent-gui-detail-error-toast")).toBeNull();
    const errorChrome = screen.getByRole("alert");
    expect(errorChrome).toHaveTextContent(
      "Something went wrong. Please try again."
    );
    expect(errorChrome.className).toContain("agent-gui-chrome__card--danger");
    expect(
      screen.queryByRole("button", {
        name: "agentHost.agentGui.retryActivation"
      })
    ).toBeNull();
  });
  it("disables the composer without rendering duplicate approval chrome actions", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "blocked",
      canSubmit: false,
      pendingApproval: approvalRequest(),
      sessionChrome: {
        auth: null,
        approval: approvalRequest(),
        recovery: null,
        rawState: null
      }
    });
    renderAgentGUINode();

    expect(getComposerEditor()).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.queryByRole("button", { name: "agentHost.agentGui.send" })
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "agentHost.agentGui.stop" })
    ).toBeEnabled();
    expect(
      screen.getAllByText("agentHost.agentGui.approvalRequired")
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Yes, proceed" })
    ).toHaveLength(1);
    expect(mockSubmitApprovalOption).not.toHaveBeenCalled();
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
  });

  it("renders the approval prompt surface and routes option selections through interactive submission", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      pendingApproval: approvalRequest(),
      sessionChrome: {
        auth: null,
        approval: approvalRequest(),
        recovery: null,
        rawState: null
      }
    });

    renderAgentGUINode();

    const promptButtons = screen.getAllByRole("button", {
      name: "Yes, proceed"
    });
    expect(promptButtons).toHaveLength(1);

    fireEvent.click(promptButtons[0] as HTMLButtonElement);

    expect(mockSubmitInteractivePrompt).toHaveBeenCalledWith({
      requestId: "request-1",
      optionId: "allow_once"
    });
  });

  it("uses approval prompt keyboard shortcuts before the composer handles Enter", () => {
    window.agentHostApi.meta = {
      ...window.agentHostApi.meta,
      platform: "darwin"
    };
    const approval = approvalRequest({
      options: [
        { id: "approved", label: "Yes, proceed", kind: "allow_once" },
        {
          id: "abort",
          label: "No, and tell Codex what to do differently",
          kind: "reject_once"
        }
      ]
    });
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "should not submit",
      pendingApproval: approval,
      sessionChrome: {
        auth: null,
        approval,
        recovery: null,
        rawState: null
      }
    });

    renderAgentGUINode();

    expect(screen.getByText("agentHost.agentGui.shortcutEnter")).toBeTruthy();
    expect(
      screen.getByText("agentHost.agentGui.shortcutCmdEnter")
    ).toBeTruthy();

    fireEvent.keyDown(window, { key: "Enter" });

    expect(mockSubmitInteractivePrompt).toHaveBeenCalledWith({
      requestId: "request-1",
      optionId: "approved"
    });
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("agent-gui-composer-floating-prompt")
    ).toBeNull();
  });

  it("does not use approval prompt keyboard shortcuts while the node is inactive", () => {
    const approval = approvalRequest({
      options: [
        { id: "approved", label: "Yes, proceed", kind: "allow_once" },
        {
          id: "abort",
          label: "No, and tell Codex what to do differently",
          kind: "reject_once"
        }
      ]
    });
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "should not submit",
      pendingApproval: approval,
      sessionChrome: {
        auth: null,
        approval,
        recovery: null,
        rawState: null
      }
    });

    renderAgentGUINode({ isActive: false });

    fireEvent.keyDown(window, { key: "Enter" });

    expect(mockSubmitInteractivePrompt).not.toHaveBeenCalled();
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("agent-gui-composer-floating-prompt")
    ).toBeTruthy();
  });

  it("uses modified Enter to open feedback for the second approval prompt option", () => {
    window.agentHostApi.meta = {
      ...window.agentHostApi.meta,
      platform: "darwin"
    };
    const approval = approvalRequest({
      options: [
        { id: "approved", label: "Yes, proceed", kind: "allow_once" },
        {
          id: "abort",
          label: "No, and tell Codex what to do differently",
          kind: "reject_once"
        }
      ]
    });
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      draftPrompt: "should not submit",
      pendingApproval: approval,
      sessionChrome: {
        auth: null,
        approval,
        recovery: null,
        rawState: null
      }
    });

    renderAgentGUINode();

    fireEvent.keyDown(window, { key: "Enter", metaKey: true });

    expect(mockSubmitInteractivePrompt).not.toHaveBeenCalled();
    expect(
      screen.getByPlaceholderText("agentHost.agentGui.feedbackPlaceholder")
    ).toBe(document.activeElement);
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("agent-gui-composer-floating-prompt")
    ).toBeTruthy();
  });

  it("shows the Windows approval shortcut label on win32", () => {
    window.agentHostApi.meta = {
      ...window.agentHostApi.meta,
      platform: "win32"
    };
    const approval = approvalRequest({
      options: [
        { id: "approved", label: "Yes, proceed", kind: "allow_once" },
        {
          id: "abort",
          label: "No, and tell Codex what to do differently",
          kind: "reject_once"
        }
      ]
    });
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      pendingApproval: approval,
      sessionChrome: {
        auth: null,
        approval,
        recovery: null,
        rawState: null
      }
    });

    renderAgentGUINode();

    expect(
      screen.getByText("agentHost.agentGui.shortcutCtrEnter")
    ).toBeTruthy();
    expect(
      screen.queryByText("agentHost.agentGui.shortcutCmdEnter")
    ).toBeNull();
  });
  it("forwards transcript link actions through the shared renderer", () => {
    const onLinkAction = vi.fn<(action: WorkspaceLinkAction) => void>();
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      conversationDetail: detailViewModel({
        turns: [
          {
            id: "turn-1",
            userMessage: { id: "user-1", body: "Please inspect this" },
            userMessages: [{ id: "user-1", body: "Please inspect this" }],
            agentMessages: [
              {
                id: "assistant-1",
                body:
                  "[README](/workspace/README.md) " +
                  "`http://127.0.0.1:9999` " +
                  "[@2046494774160003072 & Codex 哈喽](mention://agent-session/session-2?workspaceId=room-1)"
              }
            ],
            toolCalls: [],
            toolCallCount: 0,
            hasFailedToolCall: false,
            agentItems: [
              {
                kind: "message",
                message: {
                  id: "assistant-1",
                  body:
                    "[README](/workspace/README.md) " +
                    "`http://127.0.0.1:9999` " +
                    "[@2046494774160003072 & Codex 哈喽](mention://agent-session/session-2?workspaceId=room-1)"
                }
              }
            ]
          }
        ]
      })
    });

    renderAgentGUINode({ onLinkAction });

    fireEvent.click(
      screen.getByRole("link", { name: "http://127.0.0.1:9999" })
    );

    expect(onLinkAction).toHaveBeenCalledWith({
      type: "open-url",
      url: "http://127.0.0.1:9999/",
      source: "agent-markdown"
    });

    fireEvent.click(screen.getByRole("link", { name: "README" }));

    expect(onLinkAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "open-workspace-file",
        path: "/workspace/README.md"
      })
    );

    fireEvent.click(
      screen.getByRole("link", { name: "2046494774160003072 & Codex 哈喽" })
    );

    expect(onLinkAction).toHaveBeenCalledWith({
      type: "open-agent-session",
      workspaceId: "room-1",
      agentSessionId: "session-2",
      source: "agent-markdown"
    });
  });

  it("opens a zoom preview for markdown images in the main transcript", async () => {
    const readFile = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([137, 80, 78, 71])
    });
    window.agentHostApi.workspace = {
      ...(window.agentHostApi.workspace ?? {}),
      readFile
    };
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:agent-gui-markdown-image")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });

    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      conversationDetail: detailViewModel({
        turns: [
          {
            id: "turn-1",
            userMessage: { id: "user-1", body: "Please inspect this" },
            userMessages: [{ id: "user-1", body: "Please inspect this" }],
            agentMessages: [
              {
                id: "assistant-1",
                body: "![generated image](/Users/example/Documents/a/output/imagegen/lamb-storybook.png)"
              }
            ],
            toolCalls: [],
            toolCallCount: 0,
            hasFailedToolCall: false,
            agentItems: [
              {
                kind: "message",
                message: {
                  id: "assistant-1",
                  body: "![generated image](/Users/example/Documents/a/output/imagegen/lamb-storybook.png)"
                }
              }
            ]
          }
        ]
      })
    });

    renderAgentGUINode();

    fireEvent.click(
      await screen.findByRole("button", {
        name: /Zoom image|common\.expandImage/
      })
    );

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(readFile).toHaveBeenCalledWith({
      path: "/Users/example/Documents/a/output/imagegen/lamb-storybook.png"
    });
  });

  it("renders and submits the ask-user interactive prompt surface", () => {
    mockViewModel = createViewModel({
      activeConversationId: "session-1",
      canSubmit: false,
      pendingInteractivePrompt: {
        kind: "ask-user",
        requestId: "request-ask",
        title: "Questions for you",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope should we use?",
            options: [{ label: "Small", description: "Minimal change" }],
            multiSelect: false
          }
        ]
      }
    });

    renderAgentGUINode();

    expect(getComposerEditor()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(
      screen.getByRole("button", { name: "Small Minimal change" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agentHost.agentGui.submitAnswers" })
    );

    expect(mockSubmitInteractivePrompt).toHaveBeenCalledWith({
      requestId: "request-ask",
      action: "submit",
      payload: {
        answers: ["Small"],
        answersByQuestionId: { scope: "Small" }
      }
    });
  });
});

async function openSharedWorkspaceReferencePicker(): Promise<void> {
  const legacyReferenceTrigger = screen.queryByRole("combobox", {
    name: "agentHost.issue.referenceWorkspaceFiles"
  });
  if (legacyReferenceTrigger) {
    fireEvent.click(legacyReferenceTrigger);
    return;
  }
  fireEvent.click(
    screen.getByRole("button", {
      name: "agentHost.agentGui.addReference"
    })
  );
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: "agentHost.issue.referenceWorkspaceFiles"
    })
  );
}

function renderAgentGUINode({
  onLinkAction,
  onAgentProviderLogin,
  onWorkspaceFileReferencesAdded,
  onOpenConversationWindow,
  state = {
    provider: "codex",
    lastActiveAgentSessionId: null,
    conversationRailWidthPx: null
  },
  onUpdateNode = vi.fn<
    (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
  >(),
  onResize = vi.fn(),
  workspaceFileReferenceAdapter = createWorkspaceFileReferenceAdapter(),
  resolveDroppedFileReferences,
  referenceSourceAggregator,
  agentActivityRuntime,
  onShowMessage = vi.fn(),
  onMinimize,
  onToggleMaximize,
  workspaceAgentProbes = null,
  onAgentProbeDemandChange,
  onAgentProbeRefreshRequest,
  managedAgentsState = createManagedAgentsState(),
  workspaceAppIcons,
  strictMode = false,
  title = "Codex",
  width = 720,
  height = 560,
  embedded = false,
  previewMode = false,
  isActive = true,
  workbenchWindowZIndex
}: {
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onAgentProviderLogin?: React.ComponentProps<
    typeof AgentGUINode
  >["onAgentProviderLogin"];
  onWorkspaceFileReferencesAdded?: React.ComponentProps<
    typeof AgentGUINode
  >["onWorkspaceFileReferencesAdded"];
  onOpenConversationWindow?: React.ComponentProps<
    typeof AgentGUINode
  >["onOpenConversationWindow"];
  state?: AgentGUINodeData;
  onUpdateNode?: (
    updater: (current: AgentGUINodeData) => AgentGUINodeData
  ) => void;
  onResize?: React.ComponentProps<typeof AgentGUINode>["onResize"];
  workspaceFileReferenceAdapter?: WorkspaceFileReferenceAdapter | null;
  resolveDroppedFileReferences?: React.ComponentProps<
    typeof AgentGUINode
  >["resolveDroppedFileReferences"];
  referenceSourceAggregator?: ReferenceSourceAggregator | null;
  agentActivityRuntime?: AgentActivityRuntime | null;
  onShowMessage?: React.ComponentProps<typeof AgentGUINode>["onShowMessage"];
  onMinimize?: () => void;
  onToggleMaximize?: () => void;
  workspaceAgentProbes?: React.ComponentProps<
    typeof AgentGUINode
  >["workspaceAgentProbes"];
  onAgentProbeDemandChange?: React.ComponentProps<
    typeof AgentGUINode
  >["onAgentProbeDemandChange"];
  onAgentProbeRefreshRequest?: React.ComponentProps<
    typeof AgentGUINode
  >["onAgentProbeRefreshRequest"];
  managedAgentsState?: React.ComponentProps<
    typeof AgentGUINode
  >["managedAgentsState"];
  workspaceAppIcons?: React.ComponentProps<
    typeof AgentGUINode
  >["workspaceAppIcons"];
  strictMode?: boolean;
  title?: string;
  width?: number;
  height?: number;
  embedded?: boolean;
  previewMode?: boolean;
  isActive?: React.ComponentProps<typeof AgentGUINode>["isActive"];
  workbenchWindowZIndex?: number;
} = {}): ReturnType<typeof render> {
  const node = (
    <AgentGUINode
      nodeId="agent-gui-1"
      workspaceId="room-1"
      currentUserId="user-1"
      workspacePath="/workspace"
      workspaceFileReferenceAdapter={workspaceFileReferenceAdapter}
      resolveDroppedFileReferences={resolveDroppedFileReferences}
      referenceSourceAggregator={referenceSourceAggregator}
      agentSettings={{ avoidGroupingEdits: false }}
      title={title}
      state={state}
      position={{ x: 0, y: 0 }}
      width={width}
      height={height}
      desktopSize={{ width: 1200, height: 800 }}
      onLinkAction={onLinkAction}
      onAgentProviderLogin={onAgentProviderLogin}
      onWorkspaceFileReferencesAdded={onWorkspaceFileReferencesAdded}
      onOpenConversationWindow={onOpenConversationWindow}
      onClose={vi.fn()}
      onResize={onResize}
      onUpdateNode={onUpdateNode}
      onMinimize={onMinimize}
      onToggleMaximize={onToggleMaximize}
      onShowMessage={onShowMessage}
      workspaceAgentProbes={workspaceAgentProbes}
      onAgentProbeDemandChange={onAgentProbeDemandChange}
      onAgentProbeRefreshRequest={onAgentProbeRefreshRequest}
      managedAgentsState={managedAgentsState}
      workspaceAppIcons={workspaceAppIcons}
      contextMentionProviders={createAgentGUITestContextMentionProviders()}
      embedded={embedded}
      previewMode={previewMode}
      isActive={isActive}
    />
  );
  const wrappedNode =
    workbenchWindowZIndex === undefined ? (
      node
    ) : (
      <section
        data-workbench-window-id="agent-gui-1"
        data-slot="viewport-menu-boundary"
        style={{ zIndex: workbenchWindowZIndex }}
      >
        {node}
      </section>
    );
  const nodeWithProviders = (
    <AgentActivityHostProvider
      agentActivityRuntime={
        agentActivityRuntime === undefined
          ? createNoopAgentActivityRuntime()
          : agentActivityRuntime
      }
    >
      {wrappedNode}
    </AgentActivityHostProvider>
  );
  return render(
    strictMode ? (
      <StrictMode>{nodeWithProviders}</StrictMode>
    ) : (
      nodeWithProviders
    )
  );
}

function createEmptyAgentActivitySnapshot(
  workspaceId: string
): AgentActivitySnapshot {
  return {
    workspaceId,
    presences: [],
    sessions: [],
    sessionMessagesById: {},
    composerOptionsByProvider: {}
  };
}

function createAgentActivitySnapshotFromViewModel(
  workspaceId: string
): AgentActivitySnapshot {
  const empty = createEmptyAgentActivitySnapshot(workspaceId);
  return {
    ...empty,
    sessions: mockViewModel.conversations.map((conversation) => ({
      workspaceId,
      agentSessionId: conversation.id,
      agentTargetId: conversation.agentTargetId,
      provider: String(conversation.provider),
      userId: conversation.userId,
      cwd: conversation.cwd,
      title: conversation.title,
      status: conversation.status,
      visible: true,
      resumable: conversation.resumable,
      pinnedAtUnixMs: conversation.pinnedAtUnixMs,
      updatedAtUnixMs: conversation.updatedAtUnixMs,
      lastEventUnixMs: conversation.updatedAtUnixMs
    }))
  };
}

function createNoopAgentActivityRuntime(): AgentActivityRuntime {
  const createSession = (workspaceId: string, agentSessionId: string) => ({
    workspaceId,
    agentSessionId,
    provider: "codex",
    cwd: "/workspace",
    title: "",
    status: "ready"
  });
  return {
    promptContentUploadSupport: { file: true, image: true },
    async goalControl(input) {
      return {
        session: createSession(input.workspaceId, input.agentSessionId),
        goal: null
      };
    },
    async cancelSession(input) {
      return {
        session: createSession(input.workspaceId, input.agentSessionId),
        canceled: false,
        reason: "no_active_turn"
      };
    },
    async createSession(input) {
      return createSession(input.workspaceId, "session-1");
    },
    async deleteSession(input) {
      void input;
      return { removed: true };
    },
    async activateSession(input) {
      return {
        session: createSession(input.workspaceId, input.agentSessionId),
        messages: [],
        activation: { status: "ready" }
      } as unknown as Awaited<
        ReturnType<AgentActivityRuntime["activateSession"]>
      >;
    },
    async getSession(workspaceId, agentSessionId) {
      return createSession(workspaceId, agentSessionId);
    },
    async getComposerOptions() {
      return {};
    },
    async updateSessionSettings(input) {
      return {
        agentSessionId: input.agentSessionId,
        settings: input.settings
      };
    },
    async warmupOpenclawGateway() {
      return { accepted: true, ready: true };
    },
    async getSessionControlState() {
      return { status: "ready" } as Awaited<
        ReturnType<AgentActivityRuntime["getSessionControlState"]>
      >;
    },
    getSnapshot(workspaceId) {
      return createAgentActivitySnapshotFromViewModel(workspaceId);
    },
    async listSessionMessages() {
      return { messages: [], latestVersion: 0, hasMore: false };
    },
    async listAgentGeneratedFiles(input) {
      return { workspaceId: input.workspaceId, entries: [] };
    },
    async load(workspaceId) {
      return createAgentActivitySnapshotFromViewModel(workspaceId);
    },
    ensureSessionSynchronized() {
      return () => undefined;
    },
    retainSessionEvents() {
      return () => undefined;
    },
    async sendInput(input) {
      const session = createSession(input.workspaceId, input.agentSessionId);
      return {
        session,
        turnId: "turn-1",
        turnLifecycle: { activeTurnId: "turn-1", phase: "submitted" },
        submitAvailability: { state: "ready" }
      };
    },
    async uploadPromptContent(input) {
      return { content: input.content };
    },
    async readSessionAttachment(input) {
      return {
        attachmentId: input.attachmentId,
        mimeType: "application/octet-stream",
        data: ""
      };
    },
    async readPromptAsset(input) {
      return {
        assetId: input.assetId ?? undefined,
        mimeType: input.mimeType,
        path: input.path ?? "",
        data: ""
      };
    },
    async setSessionPinned(input) {
      return createSession(input.workspaceId, input.agentSessionId);
    },
    async renameSession(input) {
      return {
        ...createSession(input.workspaceId, input.agentSessionId),
        title: input.title,
        updatedAtUnixMs: 2
      };
    },
    async trackSettingsProjectChange() {},
    async trackDraftComposerSettingsChange() {},
    reportDiagnostic() {},
    async unactivateSession(input) {
      return {
        agentSessionId: input.agentSessionId,
        buffered: true
      };
    },
    async submitInteractive() {
      return {};
    },
    subscribeSessionEvents() {
      return () => undefined;
    },
    subscribe() {
      return () => undefined;
    }
  };
}

function getChromeNewConversationButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    ".agent-gui-node__new-conversation-icon-button"
  );
  if (!button) {
    throw new Error("Expected chrome new conversation button to render.");
  }
  return button;
}

function createWorkspaceFileReferenceAdapter(): WorkspaceFileReferenceAdapter {
  return {
    async loadReferenceTree() {
      return {
        budgetExceeded: false,
        directory: {
          directoryPath: "/workspace",
          entries: [
            {
              displayName: "README.md",
              kind: "file",
              path: "/workspace/docs/README.md"
            }
          ],
          prefetchState: "loaded"
        },
        prefetchBudgetMs: 500,
        prefetchDepth: 4,
        rootPath: "/workspace"
      };
    }
  };
}

function createManagedAgentsState(
  overrides: Partial<AgentHostManagedAgentsState> = {}
): AgentHostManagedAgentsState {
  return {
    metadataSynced: true,
    toolCatalogRevision: "catalog-1",
    agentProfileRevision: "profile-1",
    totalCount: 6,
    readyAgentIds: [
      "codex",
      "claude-code",
      "hermes",
      "hermes",
      "openclaw",
      "nexight"
    ],
    configSyncedAgentIds: [],
    items: [],
    ...overrides
  };
}

function createManagedAgentsStateItem(
  overrides: Partial<AgentHostManagedAgentsState["items"][number]> = {}
): AgentHostManagedAgentsState["items"][number] {
  return {
    toolId: "codex-cli",
    toolClass: "extend-agent",
    agentId: "codex",
    hostDetected: true,
    hostConfigDetected: true,
    hostVersion: "1.0.0",
    targetVersion: "latest",
    decisionReason: "test",
    fallbackApplied: false,
    ...overrides
  };
}

function createViewModel(
  overrides: Partial<AgentGUINodeViewModel> = {}
): AgentGUINodeViewModel {
  const draftContent =
    overrides.draftContent ?? createDraft(overrides.draftPrompt ?? "");
  const draftPrompt = overrides.draftPrompt ?? draftContent.prompt;
  return {
    workspaceId: "room-1",
    data: {
      provider: "codex",
      lastActiveAgentSessionId: null,
      conversationRailWidthPx: null
    },
    selectedProviderTarget: createLocalAgentGUIProviderTarget("codex"),
    providerTargets: [createLocalAgentGUIProviderTarget("codex")],
    handoffProviderTargets: [createLocalAgentGUIProviderTarget("codex")],
    providerTargetsLoading: false,
    providerRailMode: "catalog",
    comingSoonProviders: [],
    conversations: [],
    userProjects: [],
    activeConversation: null,
    activeConversationId: null,
    availableCommands: [],
    availableSkills: [],
    draftPrompt,
    draftContent,
    isLoadingConversations: false,
    isLoadingMessages: false,
    isLoadingOlderMessages: false,
    hasOlderMessages: false,
    isCreatingConversation: false,
    isSubmitting: false,
    isInterrupting: false,
    isCancelPending: false,
    isRespondingApproval: false,
    canCancel: true,
    canSubmitInteractive: true,
    canGoalControl: true,
    canUploadAttachment: true,
    promptImagesSupported: true,
    compactSupported: null,
    goalPauseSupported: true,
    usage: null,
    backgroundAgentCount: 0,
    isDeletingConversation: false,
    isDeletingProjectConversations: false,
    pendingDeleteConversation: null,
    pendingDeleteProjectConversations: null,
    pendingDeleteConversations: null,
    pendingApproval: null,
    pendingInteractivePrompt: null,
    activeLiveState: "active",
    activationError: null,
    openclawGateway: null,
    activeConversationBusy: false,
    canSubmit: true,
    canQueueWhileBusy: false,
    hasSentUserMessage: false,
    composerSettings: {
      sessionSettings: null,
      draftSettings: {
        model: null,
        reasoningEffort: null,
        speed: null,
        planMode: false,
        browserUse: true,
        permissionModeId: "preset"
      },
      supportsModel: true,
      supportsReasoningEffort: true,
      supportsSpeed: true,
      speedUnavailable: false,
      availableSpeeds: [],
      supportsPlanMode: true,
      isSettingsLoading: false,
      modelUnavailable: false,
      reasoningUnavailable: false,
      availableModels: [],
      availableReasoningEfforts: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "max", label: "Max" }
      ]
    },
    queuedPrompts: [],
    drainingQueuedPromptId: null,
    avoidGroupingEdits: false,
    conversationDetail: null,
    sessionChrome: {
      auth: null,
      approval: null,
      recovery: null,
      rawState: null
    },
    inlineNotice: null,
    ...overrides,
    conversationFilter: overrides.conversationFilter ?? { kind: "all" },
    providerReadinessGate: overrides.providerReadinessGate ?? null,
    listError: overrides.listError ?? null
  };
}

function approvalRequest(
  overrides: Partial<ReturnType<typeof approvalRequestBase>> = {}
) {
  return {
    ...approvalRequestBase(),
    ...overrides
  };
}

function approvalRequestBase() {
  return {
    kind: "approval" as const,
    id: "approval:approval-1",
    turnId: "turn-1",
    requestId: "request-1",
    callId: "approval-1",
    title: "Run command",
    status: "waiting_approval",
    toolName: "Bash",
    input: null,
    options: [{ id: "allow_once", label: "Allow once", kind: "allow_once" }],
    output: null,
    occurredAtUnixMs: 1
  };
}

function detailViewModel(
  overrides: Partial<WorkspaceAgentSessionDetailViewModel> = {}
): WorkspaceAgentSessionDetailViewModel {
  return {
    activity: {
      id: "activity-session-1",
      sessionId: "session-1",
      userId: "user-1",
      userName: "Taylor",
      agentProvider: "codex",
      agentName: "Codex",
      title: "Codex",
      status: "working" as const,
      latestActivitySummary: "Working",
      changedFiles: [],
      sortTimeUnixMs: 1
    },
    session: {
      id: 1,
      agentSessionId: "session-1",
      presenceId: 0,
      userId: "user-1",
      provider: "codex",
      providerSessionId: "provider-session-1",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
      cwd: "/workspace",
      lifecycleStatus: "active",
      turnPhase: "working",
      effectiveStatus: "working",
      title: "Codex",
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1
    },
    cwd: "/workspace",
    workspaceRoot: "/workspace",
    turns: [
      {
        id: "turn-1",
        userMessage: { id: "user-1", body: "Please inspect this" },
        userMessages: [{ id: "user-1", body: "Please inspect this" }],
        agentMessages: [{ id: "assistant-1", body: "I will check it." }],
        toolCalls: [
          {
            id: "call:1",
            name: "Read file",
            toolName: "read_file",
            callType: "tool",
            status: "Completed" as const,
            statusKind: "completed" as const,
            summary: "/workspace/README.md",
            payload: null
          }
        ],
        toolCallCount: 1,
        hasFailedToolCall: false,
        agentItems: [
          {
            kind: "message",
            message: { id: "assistant-1", body: "I will check it." }
          },
          {
            kind: "tool-calls",
            id: "tools-1",
            toolCalls: [
              {
                id: "call:1",
                name: "Read file",
                toolName: "read_file",
                callType: "tool",
                status: "Completed" as const,
                statusKind: "completed" as const,
                summary: "/workspace/README.md",
                payload: null
              }
            ],
            toolCallCount: 1,
            hasFailedToolCall: false
          }
        ]
      }
    ],
    ...overrides
  };
}
