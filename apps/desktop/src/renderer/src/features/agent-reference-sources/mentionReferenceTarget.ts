import type { AgentGUIProps } from "@tutti-os/agent-gui";
import { APP_ARTIFACT_SOURCE_ID } from "./appArtifactReferenceSource.ts";
import { ISSUE_SOURCE_ID } from "./issueReferenceSource.ts";

/**
 * 把 @ 面板里的事项/应用 mention 解析为引用 picker 的定位目标。
 * 源 id(issue-file / app-artifact)与 params 形态是本宿主侧 reference source 的知识,
 * 故映射收在 desktop;agent-gui 只负责把该函数透传到 picker。
 */
export type MentionReferenceTargetResolver = NonNullable<
  AgentGUIProps["workspace"]["resolveMentionReferenceTarget"]
>;

export const resolveMentionReferenceTarget: MentionReferenceTargetResolver = (
  item
) => {
  if (item.kind === "workspace-app") {
    const appId = item.appId?.trim() || item.targetId?.trim();
    if (!appId) {
      return null;
    }
    const params: Record<string, string> = { appId };
    return { sourceId: APP_ARTIFACT_SOURCE_ID, params };
  }
  if (item.kind === "workspace-issue") {
    const issueId = item.targetId?.trim();
    if (!issueId) {
      return null;
    }
    const params: Record<string, string> = { issueId };
    const topicId = item.topicId?.trim();
    if (topicId) {
      params.topicId = topicId;
    }
    return { sourceId: ISSUE_SOURCE_ID, params };
  }
  // 项目/任务引用 chip:source=app → 应用产物源(appId + 可选 groupId 子分组);
  // source=task → 议题源(topicId 顶层容器 + 可选 issueId 子分组)。
  if (item.kind === "workspace-reference") {
    const id = item.targetId?.trim();
    const groupId = item.groupId?.trim();
    if (item.source === "app") {
      if (!id) {
        return null;
      }
      const params: Record<string, string> = { appId: id };
      if (groupId) {
        params.groupId = groupId;
      }
      return { sourceId: APP_ARTIFACT_SOURCE_ID, params };
    }
    // source === "task":id = topicId,groupId = issueId。
    const params: Record<string, string> = {};
    if (id) {
      params.topicId = id;
    }
    if (groupId) {
      params.issueId = groupId;
    }
    if (!params.topicId && !params.issueId) {
      return null;
    }
    return { sourceId: ISSUE_SOURCE_ID, params };
  }
  return null;
};
