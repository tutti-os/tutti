package workspace

import (
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

func GeneratedIssueManagerIssueFromDomain(item workspaceissues.Issue) tuttigenerated.IssueManagerIssue {
	return tuttigenerated.IssueManagerIssue{
		IssueId:             item.IssueID,
		WorkspaceId:         item.WorkspaceID,
		TopicId:             item.TopicID,
		Title:               item.Title,
		Content:             item.Content,
		Status:              tuttigenerated.IssueManagerStatus(item.Status),
		PlanningSource:      tuttigenerated.IssueManagerPlanningSource(item.PlanningSource),
		SourceSessionId:     item.SourceSessionID,
		SequentialExecution: item.SequentialExecution,
		ParallelExecution:   item.ParallelExecution,
		ExecutionProfile: tuttigenerated.IssueManagerExecutionProfile{
			ReasoningIntensity:     item.ExecutionProfile.ReasoningIntensity,
			OrchestrationIntensity: item.ExecutionProfile.OrchestrationIntensity,
		},
		Budget: tuttigenerated.IssueManagerBudget{
			Mode:                  tuttigenerated.IssueManagerBudgetMode(item.Budget.Mode),
			TokenLimit:            item.Budget.TokenLimit,
			ConsumedTokens:        item.Budget.ConsumedTokens,
			QuotaWaterlinePercent: item.Budget.QuotaWaterlinePercent,
			RemainingQuotaPercent: issueManagerRemainingQuotaPercent(item.Budget),
			Status:                tuttigenerated.IssueManagerBudgetStatus(item.Budget.Status),
		},
		TaskCount:              item.TaskCount,
		NotStartedCount:        item.NotStartedCount,
		RunningCount:           item.RunningCount,
		PendingAcceptanceCount: item.PendingAcceptanceCount,
		CompletedCount:         item.CompletedCount,
		FailedCount:            item.FailedCount,
		CanceledCount:          item.CanceledCount,
		CreatorUserId:          item.CreatorUserID,
		CreatorDisplayName:     item.CreatorDisplayName,
		CreatorAvatarUrl:       item.CreatorAvatarURL,
		CreatedAtUnix:          unixSecondsFromMillis(item.CreatedAtUnixMS),
		UpdatedAtUnix:          unixSecondsFromMillis(item.UpdatedAtUnixMS),
	}
}

func issueManagerRemainingQuotaPercent(budget workspaceissues.Budget) *float64 {
	if !budget.HasRemainingQuota {
		return nil
	}
	value := budget.RemainingQuotaPercent
	return &value
}

func GeneratedIssueManagerTopicFromDomain(item workspaceissues.Topic) tuttigenerated.IssueManagerTopic {
	return tuttigenerated.IssueManagerTopic{
		TopicId:            item.TopicID,
		WorkspaceId:        item.WorkspaceID,
		Title:              item.Title,
		Summary:            item.Summary,
		IsDefault:          item.IsDefault,
		PinnedAtUnix:       unixSecondsFromMillis(item.PinnedAtUnixMS),
		LastActivityAtUnix: unixSecondsFromMillis(item.LastActivityAtUnixMS),
		CreatedAtUnix:      unixSecondsFromMillis(item.CreatedAtUnixMS),
		UpdatedAtUnix:      unixSecondsFromMillis(item.UpdatedAtUnixMS),
	}
}

func GeneratedIssueManagerTopicsFromDomain(items []workspaceissues.Topic) []tuttigenerated.IssueManagerTopic {
	if len(items) == 0 {
		return []tuttigenerated.IssueManagerTopic{}
	}
	result := make([]tuttigenerated.IssueManagerTopic, 0, len(items))
	for _, item := range items {
		result = append(result, GeneratedIssueManagerTopicFromDomain(item))
	}
	return result
}

func GeneratedIssueManagerTopicListResponseFromDomain(list workspaceissues.TopicList) tuttigenerated.IssueManagerTopicListResponse {
	return tuttigenerated.IssueManagerTopicListResponse{
		Topics: GeneratedIssueManagerTopicsFromDomain(list.Items),
	}
}

func GeneratedIssueManagerTopicResponseFromDomain(item workspaceissues.Topic) tuttigenerated.IssueManagerTopicResponse {
	return tuttigenerated.IssueManagerTopicResponse{
		Topic: GeneratedIssueManagerTopicFromDomain(item),
	}
}

func GeneratedIssueManagerIssueListResponseFromDomain(list workspaceissues.IssueList) tuttigenerated.IssueManagerIssueListResponse {
	return tuttigenerated.IssueManagerIssueListResponse{
		Issues:        GeneratedIssueManagerIssuesFromDomain(list.Items),
		NextPageToken: stringPointerIfNotEmpty(list.NextPageToken),
		TotalCount:    list.TotalCount,
		StatusCounts:  GeneratedIssueManagerStatusCountsFromDomain(list.StatusCounts),
	}
}

func GeneratedIssueManagerIssueResponseFromDomain(item workspaceissues.Issue) tuttigenerated.IssueManagerIssueResponse {
	return tuttigenerated.IssueManagerIssueResponse{
		Issue: GeneratedIssueManagerIssueFromDomain(item),
	}
}

func GeneratedIssueManagerIssueDetailResponseFromDomain(detail workspaceissues.IssueDetail) tuttigenerated.IssueManagerIssueDetailResponse {
	return tuttigenerated.IssueManagerIssueDetailResponse{
		Issue:         GeneratedIssueManagerIssueFromDomain(detail.Issue),
		Tasks:         GeneratedIssueManagerTasksFromDomain(detail.Tasks),
		ContextRefs:   GeneratedIssueManagerContextRefsFromDomain(detail.ContextRefs),
		LatestRun:     latestRunPointer(detail.LatestRun),
		RecentRuns:    GeneratedIssueManagerRunsFromDomain(detail.RecentRuns),
		LatestOutputs: GeneratedIssueManagerRunOutputsFromDomain(detail.LatestOutputs),
	}
}

func GeneratedIssueManagerIssuesFromDomain(items []workspaceissues.Issue) []tuttigenerated.IssueManagerIssue {
	if len(items) == 0 {
		return []tuttigenerated.IssueManagerIssue{}
	}
	result := make([]tuttigenerated.IssueManagerIssue, 0, len(items))
	for _, item := range items {
		result = append(result, GeneratedIssueManagerIssueFromDomain(item))
	}
	return result
}

func GeneratedIssueManagerTaskFromDomain(item workspaceissues.Task) tuttigenerated.IssueManagerTask {
	return tuttigenerated.IssueManagerTask{
		TaskId:             item.TaskID,
		IssueId:            item.IssueID,
		WorkspaceId:        item.WorkspaceID,
		Title:              item.Title,
		Content:            item.Content,
		Status:             tuttigenerated.IssueManagerStatus(item.Status),
		Priority:           tuttigenerated.IssueManagerPriority(item.Priority),
		SortIndex:          item.SortIndex,
		DueAtUnix:          unixSecondsFromMillis(item.DueAtUnixMS),
		CreatorUserId:      item.CreatorUserID,
		CreatorDisplayName: item.CreatorDisplayName,
		CreatorAvatarUrl:   item.CreatorAvatarURL,
		LatestRunId:        item.LatestRunID,
		AgentTargetId:      item.AgentTargetID,
		ModelPlanId:        item.ModelPlanID,
		Model:              item.Model,
		ExecutionDirectory: item.ExecutionDirectory,
		DependencyTaskIds:  append([]string(nil), item.DependencyTaskIDs...),
		Parallelizable:     item.Parallelizable,
		CreatedAtUnix:      unixSecondsFromMillis(item.CreatedAtUnixMS),
		UpdatedAtUnix:      unixSecondsFromMillis(item.UpdatedAtUnixMS),
	}
}

func GeneratedIssueManagerTaskListResponseFromDomain(list workspaceissues.TaskList) tuttigenerated.IssueManagerTaskListResponse {
	return tuttigenerated.IssueManagerTaskListResponse{
		Tasks:         GeneratedIssueManagerTasksFromDomain(list.Items),
		NextPageToken: stringPointerIfNotEmpty(list.NextPageToken),
		TotalCount:    list.TotalCount,
		StatusCounts:  GeneratedIssueManagerStatusCountsFromDomain(list.StatusCounts),
	}
}

func GeneratedIssueManagerTaskResponseFromDomain(item workspaceissues.Task) tuttigenerated.IssueManagerTaskResponse {
	return tuttigenerated.IssueManagerTaskResponse{
		Task: GeneratedIssueManagerTaskFromDomain(item),
	}
}

func GeneratedIssueManagerTasksResponseFromDomain(items []workspaceissues.Task) tuttigenerated.IssueManagerTasksResponse {
	return tuttigenerated.IssueManagerTasksResponse{
		Tasks: GeneratedIssueManagerTasksFromDomain(items),
	}
}

func GeneratedIssueManagerTaskDetailResponseFromDomain(detail workspaceissues.TaskDetail) tuttigenerated.IssueManagerTaskDetailResponse {
	return tuttigenerated.IssueManagerTaskDetailResponse{
		Task:          GeneratedIssueManagerTaskFromDomain(detail.Task),
		ContextRefs:   GeneratedIssueManagerContextRefsFromDomain(detail.ContextRefs),
		LatestRun:     latestRunPointer(detail.LatestRun),
		RecentRuns:    GeneratedIssueManagerRunsFromDomain(detail.RecentRuns),
		LatestOutputs: GeneratedIssueManagerRunOutputsFromDomain(detail.LatestOutputs),
	}
}

func GeneratedIssueManagerTasksFromDomain(items []workspaceissues.Task) []tuttigenerated.IssueManagerTask {
	if len(items) == 0 {
		return []tuttigenerated.IssueManagerTask{}
	}
	result := make([]tuttigenerated.IssueManagerTask, 0, len(items))
	for _, item := range items {
		result = append(result, GeneratedIssueManagerTaskFromDomain(item))
	}
	return result
}

func GeneratedIssueManagerRunFromDomain(item workspaceissues.Run) tuttigenerated.IssueManagerRun {
	return tuttigenerated.IssueManagerRun{
		RunId:              item.RunID,
		TaskId:             stringPointerIfNotEmpty(item.TaskID),
		IssueId:            item.IssueID,
		WorkspaceId:        item.WorkspaceID,
		RequesterUserId:    item.RequesterUserID,
		AgentUserId:        item.AgentUserID,
		AgentTargetId:      item.AgentTargetID,
		AgentSessionId:     item.AgentSessionID,
		AgentProvider:      item.AgentProvider,
		Status:             tuttigenerated.IssueManagerStatus(item.Status),
		Summary:            item.Summary,
		ErrorMessage:       item.ErrorMessage,
		OutputDir:          item.OutputDir,
		ExecutionDirectory: item.ExecutionDirectory,
		CreatedAtUnix:      unixSecondsFromMillis(item.CreatedAtUnixMS),
		StartedAtUnix:      unixSecondsFromMillis(item.StartedAtUnixMS),
		CompletedAtUnix:    unixSecondsFromMillis(item.CompletedAtUnixMS),
		UpdatedAtUnix:      unixSecondsFromMillis(item.UpdatedAtUnixMS),
	}
}

func GeneratedIssueManagerRunResponseFromDomain(item workspaceissues.Run) tuttigenerated.IssueManagerRunResponse {
	return tuttigenerated.IssueManagerRunResponse{
		Run: GeneratedIssueManagerRunFromDomain(item),
	}
}

func GeneratedIssueManagerRunListResponseFromDomain(items []workspaceissues.Run) tuttigenerated.IssueManagerRunListResponse {
	return tuttigenerated.IssueManagerRunListResponse{
		Runs: GeneratedIssueManagerRunsFromDomain(items),
	}
}

func GeneratedIssueManagerRunEnvelopeFromDomain(detail workspaceissues.RunDetail) tuttigenerated.IssueManagerRunEnvelope {
	return tuttigenerated.IssueManagerRunEnvelope{
		Run:     GeneratedIssueManagerRunFromDomain(detail.Run),
		Outputs: GeneratedIssueManagerRunOutputsFromDomain(detail.Outputs),
	}
}

func GeneratedIssueManagerRunsFromDomain(items []workspaceissues.Run) []tuttigenerated.IssueManagerRun {
	if len(items) == 0 {
		return []tuttigenerated.IssueManagerRun{}
	}
	result := make([]tuttigenerated.IssueManagerRun, 0, len(items))
	for _, item := range items {
		result = append(result, GeneratedIssueManagerRunFromDomain(item))
	}
	return result
}

func GeneratedIssueManagerRunOutputFromDomain(item workspaceissues.RunOutput) tuttigenerated.IssueManagerRunOutput {
	return tuttigenerated.IssueManagerRunOutput{
		OutputId:      item.OutputID,
		RunId:         item.RunID,
		TaskId:        stringPointerIfNotEmpty(item.TaskID),
		IssueId:       item.IssueID,
		WorkspaceId:   item.WorkspaceID,
		Path:          item.Path,
		DisplayName:   item.DisplayName,
		MediaType:     item.MediaType,
		SizeBytes:     item.SizeBytes,
		CreatedAtUnix: unixSecondsFromMillis(item.CreatedAtUnixMS),
	}
}

func latestRunPointer(item *workspaceissues.Run) *tuttigenerated.IssueManagerRun {
	if item == nil {
		return nil
	}
	value := GeneratedIssueManagerRunFromDomain(*item)
	return &value
}

func GeneratedIssueManagerRunOutputsFromDomain(items []workspaceissues.RunOutput) []tuttigenerated.IssueManagerRunOutput {
	if len(items) == 0 {
		return []tuttigenerated.IssueManagerRunOutput{}
	}
	result := make([]tuttigenerated.IssueManagerRunOutput, 0, len(items))
	for _, item := range items {
		result = append(result, GeneratedIssueManagerRunOutputFromDomain(item))
	}
	return result
}

func GeneratedIssueManagerReferenceSearchResponseFromDomain(workspaceID string, hits []workspaceissues.RunOutputSearchHit) tuttigenerated.IssueManagerReferenceSearchResponse {
	items := make([]tuttigenerated.IssueManagerReferenceSearchHit, 0, len(hits))
	for _, hit := range hits {
		items = append(items, tuttigenerated.IssueManagerReferenceSearchHit{
			Output:     GeneratedIssueManagerRunOutputFromDomain(hit.Output),
			IssueTitle: hit.IssueTitle,
		})
	}
	return tuttigenerated.IssueManagerReferenceSearchResponse{
		WorkspaceId: workspaceID,
		Items:       items,
	}
}

func GeneratedIssueManagerContextRefsResponseFromDomain(items []workspaceissues.ContextRef) tuttigenerated.IssueManagerContextRefsResponse {
	return tuttigenerated.IssueManagerContextRefsResponse{
		ContextRefs: GeneratedIssueManagerContextRefsFromDomain(items),
	}
}

func GeneratedIssueManagerContextRefsFromDomain(items []workspaceissues.ContextRef) []tuttigenerated.IssueManagerContextRef {
	if len(items) == 0 {
		return []tuttigenerated.IssueManagerContextRef{}
	}
	result := make([]tuttigenerated.IssueManagerContextRef, 0, len(items))
	for _, item := range items {
		result = append(result, GeneratedIssueManagerContextRefFromDomain(item))
	}
	return result
}

func GeneratedIssueManagerContextRefFromDomain(item workspaceissues.ContextRef) tuttigenerated.IssueManagerContextRef {
	if item.ParentKind == workspaceissues.ContextRefParentTask {
		ref := tuttigenerated.IssueManagerContextRef{}
		_ = ref.FromIssueManagerTaskContextRef(tuttigenerated.IssueManagerTaskContextRef{
			ContextRefId:  item.ContextRefID,
			WorkspaceId:   item.WorkspaceID,
			IssueId:       item.IssueID,
			TaskId:        item.TaskID,
			ParentKind:    tuttigenerated.IssueManagerTaskContextRefParentKindTask,
			RefType:       item.RefType,
			Path:          item.Path,
			DisplayName:   item.DisplayName,
			CreatedAtUnix: unixSecondsFromMillis(item.CreatedAtUnixMS),
		})
		return ref
	}

	ref := tuttigenerated.IssueManagerContextRef{}
	_ = ref.FromIssueManagerIssueContextRef(tuttigenerated.IssueManagerIssueContextRef{
		ContextRefId:  item.ContextRefID,
		WorkspaceId:   item.WorkspaceID,
		IssueId:       item.IssueID,
		ParentKind:    tuttigenerated.IssueManagerIssueContextRefParentKindIssue,
		RefType:       item.RefType,
		Path:          item.Path,
		DisplayName:   item.DisplayName,
		CreatedAtUnix: unixSecondsFromMillis(item.CreatedAtUnixMS),
	})
	return ref
}

func GeneratedIssueManagerStatusCountsFromDomain(counts workspaceissues.StatusCounts) tuttigenerated.IssueManagerStatusCounts {
	return tuttigenerated.IssueManagerStatusCounts{
		All:               counts.All,
		NotStarted:        counts.NotStarted,
		Running:           counts.Running,
		PendingAcceptance: counts.PendingAcceptance,
		Completed:         counts.Completed,
		Failed:            counts.Failed,
		Canceled:          counts.Canceled,
	}
}

func UnixMillisFromSeconds(value int64) int64 {
	if value <= 0 {
		return 0
	}
	return value * 1000
}

func unixSecondsFromMillis(value int64) int64 {
	if value <= 0 {
		return 0
	}
	return value / 1000
}

func stringPointerIfNotEmpty(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
