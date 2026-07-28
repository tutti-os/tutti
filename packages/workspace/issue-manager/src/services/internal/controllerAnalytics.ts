import { toAnalyticsProtocolParams } from "@tutti-os/analytics";
import type { IssueManagerFileReference } from "../../contracts/index.ts";
import type { IssueManagerAnalyticsEvent } from "../../contracts/index.ts";
import {
  extractIssueManagerWorkspaceFileLinksFromContent,
  type IssueManagerFeature
} from "../../core/index.ts";

export function trackIssueManagerAnalytics(
  feature: IssueManagerFeature,
  event: IssueManagerAnalyticsEvent
): void {
  const reporting = feature.reporterService
    ? feature.reporterService.trackEvents([
        {
          name: event.name,
          params: toAnalyticsProtocolParams(event.params)
        }
      ])
    : feature.analytics?.track(event);
  void Promise.resolve(reporting).catch(() => undefined);
}

export function trackIssueManagerContextRefsAdded(input: {
  feature: IssueManagerFeature;
  refs: readonly IssueManagerFileReference[];
  targetType: "issue" | "task";
}): void {
  const seen = new Set<string>();
  for (const ref of input.refs) {
    const path = ref.path.trim();
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    trackIssueManagerAnalytics(input.feature, {
      name: "issue_manager.context_ref_added",
      params: {
        refType: issueManagerAnalyticsRefType(ref.kind),
        targetType: input.targetType
      }
    });
  }
}

export function trackIssueManagerContentReferenceChanges(input: {
  feature: IssueManagerFeature;
  nextContent: string;
  previousContent: string;
  targetType: "issue" | "task";
}): void {
  const previousRefs = extractIssueManagerWorkspaceFileLinksFromContent(
    input.previousContent
  );
  const nextRefs = extractIssueManagerWorkspaceFileLinksFromContent(
    input.nextContent
  );
  const previousPaths = new Set(
    previousRefs.map((ref) => ref.path.trim()).filter(Boolean)
  );
  const nextPaths = new Set(
    nextRefs.map((ref) => ref.path.trim()).filter(Boolean)
  );

  trackIssueManagerContextRefsAdded({
    feature: input.feature,
    refs: nextRefs.filter((ref) => !previousPaths.has(ref.path.trim())),
    targetType: input.targetType
  });

  for (const path of previousPaths) {
    if (nextPaths.has(path)) {
      continue;
    }
    trackIssueManagerAnalytics(input.feature, {
      name: "issue_manager.context_ref_removed",
      params: {
        targetType: input.targetType
      }
    });
  }
}

function issueManagerAnalyticsRefType(
  kind: IssueManagerFileReference["kind"]
): "directory" | "file" | "upload" {
  return kind === "folder" ? "directory" : "file";
}
