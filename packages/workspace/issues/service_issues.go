package workspaceissues

import (
	"context"
	"strings"
)

func (s Service) ListIssues(ctx context.Context, filter IssueListFilter) (IssueList, error) {
	store, err := s.store()
	if err != nil {
		return IssueList{}, err
	}
	filter.WorkspaceID = strings.TrimSpace(filter.WorkspaceID)
	filter.TopicID = strings.TrimSpace(filter.TopicID)
	if filter.WorkspaceID == "" || filter.TopicID == "" {
		return IssueList{}, ErrInvalidArgument
	}
	if filter.StatusFilter != "" {
		if _, ok := NormalizeStatus(string(filter.StatusFilter)); !ok {
			return IssueList{}, ErrInvalidArgument
		}
	}
	filter.SearchQuery = strings.TrimSpace(filter.SearchQuery)
	if _, err := store.GetTopic(ctx, filter.WorkspaceID, filter.TopicID); err != nil {
		return IssueList{}, err
	}
	list, err := store.ListIssues(ctx, filter)
	if err != nil {
		return IssueList{}, err
	}
	list.NextPageToken = EncodeIssueListCursorToken(list.NextCursor)
	return list, nil
}

func (s Service) CreateIssue(ctx context.Context, input CreateIssueInput) (Issue, error) {
	store, err := s.store()
	if err != nil {
		return Issue{}, err
	}
	issue, err := s.buildIssue(ctx, store, input)
	if err != nil {
		return Issue{}, err
	}
	created, err := store.CreateIssue(ctx, issue)
	if err != nil {
		return Issue{}, err
	}
	if err := store.TouchTopicActivity(ctx, issue.WorkspaceID, issue.TopicID, issue.UpdatedAtUnixMS); err != nil {
		return Issue{}, err
	}
	return created, nil
}

func (s Service) buildIssue(ctx context.Context, store Store, input CreateIssueInput) (Issue, error) {
	if input.SequentialExecution && input.ParallelExecution {
		return Issue{}, ErrInvalidArgument
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	topicID := strings.TrimSpace(input.TopicID)
	actorUserID := strings.TrimSpace(input.ActorUserID)
	title := strings.TrimSpace(input.Title)
	if workspaceID == "" || topicID == "" || actorUserID == "" || title == "" {
		return Issue{}, ErrInvalidArgument
	}
	if _, err := store.GetTopic(ctx, workspaceID, topicID); err != nil {
		return Issue{}, err
	}
	planningSource := PlanningSourceManual
	if strings.TrimSpace(input.PlanningSource) != "" {
		var ok bool
		planningSource, ok = NormalizePlanningSource(input.PlanningSource)
		if !ok {
			return Issue{}, ErrInvalidArgument
		}
	}
	profile := DefaultExecutionProfile()
	if input.HasExecutionProfile {
		var ok bool
		profile, ok = NormalizeExecutionProfile(input.ExecutionProfile)
		if !ok {
			return Issue{}, ErrInvalidArgument
		}
	}
	budget := DefaultBudget()
	if input.HasBudget {
		var ok bool
		budget, ok = NormalizeBudget(input.Budget)
		if !ok {
			return Issue{}, ErrInvalidArgument
		}
	}
	now := s.nowUnixMS()
	issue := Issue{
		IssueID:             s.resolveID(IDKindIssue, input.IssueID),
		TopicID:             topicID,
		WorkspaceID:         workspaceID,
		Title:               title,
		Content:             strings.TrimSpace(input.Content),
		SearchText:          TrimSearchText(input.Content),
		Status:              StatusNotStarted,
		PlanningSource:      planningSource,
		SourceSessionID:     strings.TrimSpace(input.SourceSessionID),
		SequentialExecution: input.SequentialExecution,
		ParallelExecution:   input.ParallelExecution,
		ExecutionProfile:    profile,
		Budget:              budget,
		CreatorUserID:       actorUserID,
		CreatedAtUnixMS:     now,
		UpdatedAtUnixMS:     now,
	}
	if issue.IssueID == "" {
		return Issue{}, ErrInvalidArgument
	}
	return issue, nil
}

func (s Service) UpdateIssue(ctx context.Context, input UpdateIssueInput) (Issue, error) {
	store, err := s.store()
	if err != nil {
		return Issue{}, err
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	issueID := strings.TrimSpace(input.IssueID)
	if workspaceID == "" || issueID == "" || strings.TrimSpace(input.ActorUserID) == "" {
		return Issue{}, ErrInvalidArgument
	}
	issue, err := store.GetIssue(ctx, workspaceID, issueID)
	if err != nil {
		return Issue{}, err
	}
	if input.HasTitle {
		title := strings.TrimSpace(input.Title)
		if title == "" {
			return Issue{}, ErrInvalidArgument
		}
		issue.Title = title
	}
	if input.HasContent {
		issue.Content = strings.TrimSpace(input.Content)
		issue.SearchText = TrimSearchText(input.Content)
	}
	if input.HasStatus {
		status, ok := NormalizeStatus(input.Status)
		if !ok {
			return Issue{}, ErrInvalidArgument
		}
		issue.Status = status
	}
	if input.HasDispatchPaused {
		issue.DispatchPaused = input.DispatchPaused
	}
	if input.HasExecutionProfile {
		profile, ok := NormalizeExecutionProfile(input.ExecutionProfile)
		if !ok {
			return Issue{}, ErrInvalidArgument
		}
		issue.ExecutionProfile = profile
		if issue.Budget.Mode == BudgetModeAuto {
			issue.Budget.TokenLimit = CompileAutoTokenBudget(maxInt(issue.TaskCount, 1), profile)
		}
	}
	if input.HasBudget {
		budget, ok := NormalizeBudget(input.Budget)
		if !ok {
			return Issue{}, ErrInvalidArgument
		}
		budget.ConsumedTokens = issue.Budget.ConsumedTokens
		if !budget.HasRemainingQuota {
			budget.RemainingQuotaPercent = issue.Budget.RemainingQuotaPercent
			budget.HasRemainingQuota = issue.Budget.HasRemainingQuota
		}
		if budget.Mode == BudgetModeAuto {
			budget.TokenLimit = CompileAutoTokenBudget(maxInt(issue.TaskCount, 1), issue.ExecutionProfile)
		}
		budget.Status = BudgetStatusActive
		if budget.TokenLimit > 0 && budget.ConsumedTokens >= budget.TokenLimit {
			budget.Status = BudgetStatusSoftLimited
		}
		if budget.HasRemainingQuota && budget.RemainingQuotaPercent <= budget.QuotaWaterlinePercent {
			budget.Status = BudgetStatusSoftLimited
		}
		issue.Budget = budget
	}
	issue.UpdatedAtUnixMS = s.nowUnixMS()
	updated, err := store.UpdateIssue(ctx, issue)
	if err != nil {
		return Issue{}, err
	}
	if err := store.TouchTopicActivity(ctx, workspaceID, issue.TopicID, issue.UpdatedAtUnixMS); err != nil {
		return Issue{}, err
	}
	return updated, nil
}

func (s Service) GetIssueDetail(ctx context.Context, workspaceID string, issueID string) (IssueDetail, error) {
	store, err := s.store()
	if err != nil {
		return IssueDetail{}, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	issueID = strings.TrimSpace(issueID)
	if workspaceID == "" || issueID == "" {
		return IssueDetail{}, ErrInvalidArgument
	}
	issue, err := store.GetIssue(ctx, workspaceID, issueID)
	if err != nil {
		return IssueDetail{}, err
	}
	tasks, err := store.ListTasks(ctx, TaskListFilter{
		WorkspaceID: workspaceID,
		IssueID:     issueID,
		ReturnAll:   true,
	})
	if err != nil {
		return IssueDetail{}, err
	}
	refs, err := store.ListContextRefs(ctx, workspaceID, issueID, "", ContextRefParentIssue)
	if err != nil {
		return IssueDetail{}, err
	}
	runs, err := store.ListRuns(ctx, workspaceID, issueID, "")
	if err != nil {
		return IssueDetail{}, err
	}
	var latestRun *Run
	if len(runs) > 0 {
		latestRun = &runs[0]
	}
	outputs := make([]RunOutput, 0)
	seenOutputPaths := map[string]struct{}{}
	for _, run := range runs {
		runOutputs, err := store.ListRunOutputs(ctx, workspaceID, issueID, run.TaskID, run.RunID)
		if err != nil {
			return IssueDetail{}, err
		}
		for _, output := range runOutputs {
			outputPath := strings.TrimSpace(output.Path)
			if _, exists := seenOutputPaths[outputPath]; exists {
				continue
			}
			seenOutputPaths[outputPath] = struct{}{}
			outputs = append(outputs, output)
		}
	}
	return IssueDetail{
		Issue:         issue,
		Tasks:         tasks.Items,
		ContextRefs:   refs,
		LatestRun:     latestRun,
		RecentRuns:    runs,
		LatestOutputs: outputs,
	}, nil
}

const (
	defaultIssueOutputSearchLimit = 50
	maxIssueOutputSearchLimit     = 200
)

// SearchIssueOutputs searches produced output files across one workspace by file
// name, deduplicated by path and ordered by recency. IssueID / TopicID optionally
// scope the search; IssueID wins when both are set.
// normalizeRunOutputFilters trims、去重、丢弃空白的「文件类型筛选分类」id。
func normalizeRunOutputFilters(filters []string) []string {
	if len(filters) == 0 {
		return nil
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(filters))
	for _, filter := range filters {
		filter = strings.TrimSpace(filter)
		if filter == "" || seen[filter] {
			continue
		}
		seen[filter] = true
		out = append(out, filter)
	}
	return out
}

func (s Service) SearchIssueOutputs(ctx context.Context, params RunOutputSearchParams) ([]RunOutputSearchHit, error) {
	store, err := s.store()
	if err != nil {
		return nil, err
	}
	params.WorkspaceID = strings.TrimSpace(params.WorkspaceID)
	params.Query = strings.TrimSpace(params.Query)
	params.IssueID = strings.TrimSpace(params.IssueID)
	params.TopicID = strings.TrimSpace(params.TopicID)
	params.Filters = normalizeRunOutputFilters(params.Filters)
	// 筛选与搜索是同一能力:关键词与筛选同时为空才算无效查询。仅选类型筛选(Query 空)时
	// 由 store 按类型 list-all。
	if params.WorkspaceID == "" || (params.Query == "" && len(params.Filters) == 0) {
		return nil, ErrInvalidArgument
	}
	if params.Limit <= 0 {
		params.Limit = defaultIssueOutputSearchLimit
	}
	if params.Limit > maxIssueOutputSearchLimit {
		params.Limit = maxIssueOutputSearchLimit
	}
	return store.SearchRunOutputs(ctx, params)
}

func (s Service) DeleteIssue(ctx context.Context, workspaceID string, issueID string, actorUserID string) (bool, error) {
	store, err := s.store()
	if err != nil {
		return false, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	issueID = strings.TrimSpace(issueID)
	actorUserID = strings.TrimSpace(actorUserID)
	if workspaceID == "" || issueID == "" || actorUserID == "" {
		return false, ErrInvalidArgument
	}
	issue, err := store.GetIssue(ctx, workspaceID, issueID)
	if err != nil {
		return false, err
	}
	removed, err := store.DeleteIssue(ctx, workspaceID, issueID, actorUserID)
	if err != nil {
		return false, err
	}
	if !removed {
		return false, ErrIssueNotFound
	}
	if err := store.TouchTopicActivity(ctx, workspaceID, issue.TopicID, s.nowUnixMS()); err != nil {
		return false, err
	}
	return true, nil
}
