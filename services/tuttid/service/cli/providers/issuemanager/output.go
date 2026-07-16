package issuemanager

import (
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

var issueColumns = []cliservice.TableColumn{
	{Key: "id", Label: "ID"},
	{Key: "title", Label: "Title"},
	{Key: "status", Label: "Status"},
	{Key: "updatedAt", Label: "Updated"},
}

var topicColumns = []cliservice.TableColumn{
	{Key: "id", Label: "ID"},
	{Key: "title", Label: "Title"},
	{Key: "default", Label: "Default"},
	{Key: "pinned", Label: "Pinned"},
	{Key: "lastActivityAt", Label: "Last Activity"},
}

var taskColumns = []cliservice.TableColumn{
	{Key: "id", Label: "ID"},
	{Key: "title", Label: "Title"},
	{Key: "status", Label: "Status"},
	{Key: "priority", Label: "Priority"},
	{Key: "updatedAt", Label: "Updated"},
}

var runColumns = []cliservice.TableColumn{
	{Key: "id", Label: "ID"},
	{Key: "status", Label: "Status"},
	{Key: "agentProvider", Label: "Provider"},
	{Key: "agentTargetId", Label: "Target"},
	{Key: "agentSessionId", Label: "Session"},
	{Key: "updatedAt", Label: "Updated"},
}

func issueRows(items []workspaceissues.Issue) []map[string]any {
	rows := make([]map[string]any, 0, len(items))
	for _, issue := range items {
		rows = append(rows, map[string]any{
			"id":        issue.IssueID,
			"topicId":   issue.TopicID,
			"title":     issue.Title,
			"status":    string(issue.Status),
			"updatedAt": issue.UpdatedAtUnixMS,
		})
	}
	return rows
}

func topicRows(items []workspaceissues.Topic) []map[string]any {
	rows := make([]map[string]any, 0, len(items))
	for _, topic := range items {
		rows = append(rows, map[string]any{
			"id":             topic.TopicID,
			"title":          topic.Title,
			"default":        topic.IsDefault,
			"pinned":         topic.PinnedAtUnixMS > 0,
			"lastActivityAt": topic.LastActivityAtUnixMS,
		})
	}
	return rows
}

func taskRows(items []workspaceissues.Task) []map[string]any {
	rows := make([]map[string]any, 0, len(items))
	for _, task := range items {
		rows = append(rows, map[string]any{
			"id":        task.TaskID,
			"title":     task.Title,
			"status":    string(task.Status),
			"priority":  string(task.Priority),
			"updatedAt": task.UpdatedAtUnixMS,
		})
	}
	return rows
}

func runRows(items []workspaceissues.Run) []map[string]any {
	rows := make([]map[string]any, 0, len(items))
	for _, run := range items {
		rows = append(rows, map[string]any{
			"id":             run.RunID,
			"status":         string(run.Status),
			"agentProvider":  run.AgentProvider,
			"agentTargetId":  run.AgentTargetID,
			"agentSessionId": run.AgentSessionID,
			"updatedAt":      run.UpdatedAtUnixMS,
		})
	}
	return rows
}

func topicSummaryValue(item workspaceissues.Topic) map[string]any {
	return map[string]any{
		"topicId":              item.TopicID,
		"title":                item.Title,
		"isDefault":            item.IsDefault,
		"pinned":               item.PinnedAtUnixMS > 0,
		"lastActivityAtUnixMs": item.LastActivityAtUnixMS,
	}
}

func issueSummaryValue(item workspaceissues.Issue) map[string]any {
	return map[string]any{
		"issueId":         item.IssueID,
		"topicId":         item.TopicID,
		"title":           item.Title,
		"status":          string(item.Status),
		"taskCount":       item.TaskCount,
		"updatedAtUnixMs": item.UpdatedAtUnixMS,
		"planningSource":  item.PlanningSource,
		"budgetStatus":    item.Budget.Status,
	}
}

func issueDetailValue(item workspaceissues.Issue) map[string]any {
	return map[string]any{
		"issueId":                item.IssueID,
		"workspaceId":            item.WorkspaceID,
		"topicId":                item.TopicID,
		"title":                  item.Title,
		"content":                item.Content,
		"status":                 string(item.Status),
		"planningSource":         string(item.PlanningSource),
		"sourceSessionId":        item.SourceSessionID,
		"executionProfile":       map[string]any{"reasoningIntensity": item.ExecutionProfile.ReasoningIntensity, "orchestrationIntensity": item.ExecutionProfile.OrchestrationIntensity},
		"budget":                 map[string]any{"mode": string(item.Budget.Mode), "tokenLimit": item.Budget.TokenLimit, "consumedTokens": item.Budget.ConsumedTokens, "quotaWaterlinePercent": item.Budget.QuotaWaterlinePercent, "remainingQuotaPercent": item.Budget.RemainingQuotaPercent, "hasRemainingQuotaPercent": item.Budget.HasRemainingQuota, "status": string(item.Budget.Status)},
		"cost":                   map[string]any{"currency": item.Cost.Currency, "estimatedMicros": item.Cost.EstimatedMicros, "actualMicros": item.Cost.ActualMicros},
		"taskCount":              item.TaskCount,
		"notStartedCount":        item.NotStartedCount,
		"runningCount":           item.RunningCount,
		"pendingAcceptanceCount": item.PendingAcceptanceCount,
		"completedCount":         item.CompletedCount,
		"failedCount":            item.FailedCount,
		"canceledCount":          item.CanceledCount,
		"creatorUserId":          item.CreatorUserID,
		"creatorDisplayName":     item.CreatorDisplayName,
		"creatorAvatarUrl":       item.CreatorAvatarURL,
		"createdAtUnixMs":        item.CreatedAtUnixMS,
		"updatedAtUnixMs":        item.UpdatedAtUnixMS,
	}
}

func taskSummaryValue(item workspaceissues.Task) map[string]any {
	return map[string]any{
		"taskId":            item.TaskID,
		"issueId":           item.IssueID,
		"title":             item.Title,
		"status":            string(item.Status),
		"priority":          string(item.Priority),
		"sortIndex":         item.SortIndex,
		"latestRunId":       item.LatestRunID,
		"agentTargetId":     item.AgentTargetID,
		"modelPlanId":       item.ModelPlanID,
		"model":             item.Model,
		"dependencyTaskIds": item.DependencyTaskIDs,
		"acceptanceState":   string(item.AcceptanceState),
	}
}

func taskActionSummaryValue(item workspaceissues.Task) map[string]any {
	return map[string]any{
		"taskId":          item.TaskID,
		"issueId":         item.IssueID,
		"title":           item.Title,
		"status":          string(item.Status),
		"priority":        string(item.Priority),
		"agentTargetId":   item.AgentTargetID,
		"modelPlanId":     item.ModelPlanID,
		"model":           item.Model,
		"acceptanceState": string(item.AcceptanceState),
	}
}

func taskDetailValue(item workspaceissues.Task) map[string]any {
	return map[string]any{
		"taskId":             item.TaskID,
		"issueId":            item.IssueID,
		"workspaceId":        item.WorkspaceID,
		"title":              item.Title,
		"content":            item.Content,
		"status":             string(item.Status),
		"priority":           string(item.Priority),
		"sortIndex":          item.SortIndex,
		"dueAtUnixMs":        item.DueAtUnixMS,
		"agentTargetId":      item.AgentTargetID,
		"modelPlanId":        item.ModelPlanID,
		"model":              item.Model,
		"executionDirectory": item.ExecutionDirectory,
		"dependencyTaskIds":  item.DependencyTaskIDs,
		"acceptanceState":    string(item.AcceptanceState),
		"acceptanceSummary":  item.AcceptanceSummary,
		"creatorUserId":      item.CreatorUserID,
		"creatorDisplayName": item.CreatorDisplayName,
		"creatorAvatarUrl":   item.CreatorAvatarURL,
		"latestRunId":        item.LatestRunID,
		"createdAtUnixMs":    item.CreatedAtUnixMS,
		"updatedAtUnixMs":    item.UpdatedAtUnixMS,
	}
}

func runSummaryValue(item workspaceissues.Run) map[string]any {
	return map[string]any{
		"runId":              item.RunID,
		"taskId":             item.TaskID,
		"issueId":            item.IssueID,
		"status":             string(item.Status),
		"agentProvider":      item.AgentProvider,
		"agentTargetId":      item.AgentTargetID,
		"agentSessionId":     item.AgentSessionID,
		"modelPlanId":        item.ModelPlanID,
		"model":              item.Model,
		"reasoningIntensity": item.ReasoningIntensity,
		"usage":              map[string]any{"inputTokens": item.Usage.InputTokens, "outputTokens": item.Usage.OutputTokens, "cacheReadTokens": item.Usage.CacheReadTokens, "cacheWriteTokens": item.Usage.CacheWriteTokens},
		"cost":               map[string]any{"currency": item.Cost.Currency, "estimatedMicros": item.Cost.EstimatedMicros, "actualMicros": item.Cost.ActualMicros},
	}
}

func runDetailValue(item workspaceissues.Run) map[string]any {
	return map[string]any{
		"runId":              item.RunID,
		"taskId":             item.TaskID,
		"issueId":            item.IssueID,
		"workspaceId":        item.WorkspaceID,
		"requesterUserId":    item.RequesterUserID,
		"agentUserId":        item.AgentUserID,
		"agentTargetId":      item.AgentTargetID,
		"agentSessionId":     item.AgentSessionID,
		"agentProvider":      item.AgentProvider,
		"status":             string(item.Status),
		"summary":            item.Summary,
		"errorMessage":       item.ErrorMessage,
		"outputDir":          item.OutputDir,
		"executionDirectory": item.ExecutionDirectory,
		"modelPlanId":        item.ModelPlanID,
		"model":              item.Model,
		"reasoningIntensity": item.ReasoningIntensity,
		"usage":              map[string]any{"inputTokens": item.Usage.InputTokens, "outputTokens": item.Usage.OutputTokens, "cacheReadTokens": item.Usage.CacheReadTokens, "cacheWriteTokens": item.Usage.CacheWriteTokens},
		"cost":               map[string]any{"currency": item.Cost.Currency, "estimatedMicros": item.Cost.EstimatedMicros, "actualMicros": item.Cost.ActualMicros},
		"createdAtUnixMs":    item.CreatedAtUnixMS,
		"startedAtUnixMs":    item.StartedAtUnixMS,
		"completedAtUnixMs":  item.CompletedAtUnixMS,
		"updatedAtUnixMs":    item.UpdatedAtUnixMS,
	}
}

func runOutputSummaryValue(item workspaceissues.RunOutput) map[string]any {
	return map[string]any{
		"path":        item.Path,
		"displayName": item.DisplayName,
	}
}

func runOutputValue(item workspaceissues.RunOutput) map[string]any {
	return map[string]any{
		"outputId":        item.OutputID,
		"runId":           item.RunID,
		"taskId":          item.TaskID,
		"issueId":         item.IssueID,
		"workspaceId":     item.WorkspaceID,
		"path":            item.Path,
		"displayName":     item.DisplayName,
		"mediaType":       item.MediaType,
		"sizeBytes":       item.SizeBytes,
		"createdAtUnixMs": item.CreatedAtUnixMS,
	}
}

func topicSummaryValues(items []workspaceissues.Topic) []any {
	values := make([]any, 0, len(items))
	for _, item := range items {
		values = append(values, topicSummaryValue(item))
	}
	return values
}

func issueSummaryValues(items []workspaceissues.Issue) []any {
	values := make([]any, 0, len(items))
	for _, item := range items {
		values = append(values, issueSummaryValue(item))
	}
	return values
}

func taskSummaryValues(items []workspaceissues.Task) []any {
	values := make([]any, 0, len(items))
	for _, item := range items {
		values = append(values, taskSummaryValue(item))
	}
	return values
}

func runSummaryValues(items []workspaceissues.Run) []any {
	values := make([]any, 0, len(items))
	for _, item := range items {
		values = append(values, runSummaryValue(item))
	}
	return values
}

func runOutputSummaryValues(items []workspaceissues.RunOutput) []any {
	values := make([]any, 0, len(items))
	for _, item := range items {
		values = append(values, runOutputSummaryValue(item))
	}
	return values
}

func runOutputValues(items []workspaceissues.RunOutput) []any {
	values := make([]any, 0, len(items))
	for _, item := range items {
		values = append(values, runOutputValue(item))
	}
	return values
}

func statusCountsValue(counts workspaceissues.StatusCounts) map[string]any {
	return map[string]any{
		"all":               counts.All,
		"notStarted":        counts.NotStarted,
		"running":           counts.Running,
		"pendingAcceptance": counts.PendingAcceptance,
		"completed":         counts.Completed,
		"failed":            counts.Failed,
		"canceled":          counts.Canceled,
	}
}

func maybeAddNextPageToken(value map[string]any, token string) {
	if token = strings.TrimSpace(token); token != "" {
		value["nextPageToken"] = token
	}
}
