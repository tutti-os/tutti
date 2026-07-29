import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { AGENT_CONTEXT_MENTION_PROVIDER_IDS } from "@tutti-os/agent-gui/context-mention-provider";
import {
  compactMentionPresentation,
  compactStringRecord,
  createDesktopRichTextMentionInsertResult,
  createRichTextTriggerProvider,
  resolveMentionSafely,
  scopeString,
  type DesktopRichTextAtContributor
} from "./desktopRichTextAtMentionSupport.ts";

interface WorkspaceModelAtItem {
  modelId: string;
  modelName: string;
  planId: string;
  planName: string;
  workspaceId: string;
}

/**
 * Exposes models from enabled workspace access plans as @-mention candidates.
 * The plan/model identity is preserved in the mention scope so the daemon can
 * route a later `tutti agent consult` call without exposing credentials.
 */
export function createWorkspaceModelAtContributor(
  tuttidClient: TuttidClient
): DesktopRichTextAtContributor {
  return {
    capability: "workspace-model",
    getProviders(input) {
      return [
        createRichTextTriggerProvider<WorkspaceModelAtItem>({
          id: AGENT_CONTEXT_MENTION_PROVIDER_IDS.workspaceModel,
          trigger: "@",
          async query(searchInput) {
            if (searchInput.abortSignal?.aborted) {
              return [];
            }
            const response = await tuttidClient.listModelPlans(
              input.workspaceId
            );
            if (searchInput.abortSignal?.aborted) {
              return [];
            }
            return workspaceModelAtItems({
              keyword: searchInput.keyword,
              maxResults: searchInput.maxResults,
              plans: response.plans,
              workspaceId: input.workspaceId
            });
          },
          getItemKey: (item) => `${item.planId}/${item.modelId}`,
          getItemLabel: (item) => item.modelName,
          getItemSubtitle: (item) => item.planName,
          toInsertResult(item) {
            return createDesktopRichTextMentionInsertResult({
              entityId: item.modelId,
              label: item.modelName,
              scope: compactStringRecord({
                modelPlanId: item.planId,
                workspaceId: item.workspaceId
              }),
              presentation: compactMentionPresentation({
                subtitle: item.planName
              })
            });
          },
          async resolveMention(identity) {
            const workspaceId = scopeString(identity.scope, "workspaceId");
            const modelPlanId = scopeString(identity.scope, "modelPlanId");
            if (!workspaceId || !modelPlanId) {
              return null;
            }
            return resolveMentionSafely(async () => {
              const response = await tuttidClient.listModelPlans(workspaceId);
              const item = workspaceModelAtItems({
                keyword: "",
                plans: response.plans,
                workspaceId
              }).find(
                (candidate) =>
                  candidate.planId === modelPlanId &&
                  candidate.modelId === identity.entityId
              );
              return item
                ? {
                    label: item.modelName,
                    presentation: compactMentionPresentation({
                      subtitle: item.planName
                    })
                  }
                : null;
            });
          }
        })
      ];
    }
  };
}

function workspaceModelAtItems(input: {
  keyword: string;
  maxResults?: number;
  plans: Awaited<ReturnType<TuttidClient["listModelPlans"]>>["plans"];
  workspaceId: string;
}): WorkspaceModelAtItem[] {
  const keyword = input.keyword.trim().toLowerCase();
  const items = input.plans.flatMap((plan) => {
    if (!plan.enabled) {
      return [];
    }
    const planName = plan.name.trim() || plan.id;
    return plan.models.flatMap((model) => {
      const modelId = model.id.trim();
      return modelId
        ? [
            {
              modelId,
              modelName: model.name.trim() || modelId,
              planId: plan.id,
              planName,
              workspaceId: input.workspaceId
            }
          ]
        : [];
    });
  });
  const matched = items.filter(
    (item) =>
      !keyword ||
      [item.modelId, item.modelName, item.planId, item.planName]
        .join("\n")
        .toLowerCase()
        .includes(keyword)
  );
  return input.maxResults === undefined
    ? matched
    : matched.slice(0, Math.max(0, input.maxResults));
}
