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
	now := s.nowUnixMS()
	issue := Issue{
		IssueID:         s.resolveID(IDKindIssue, input.IssueID),
		TopicID:         topicID,
		WorkspaceID:     workspaceID,
		Title:           title,
		Content:         strings.TrimSpace(input.Content),
		SearchText:      TrimSearchText(input.Content),
		Status:          StatusNotStarted,
		CreatorUserID:   actorUserID,
		CreatedAtUnixMS: now,
		UpdatedAtUnixMS: now,
	}
	if issue.IssueID == "" {
		return Issue{}, ErrInvalidArgument
	}
	created, err := store.CreateIssue(ctx, issue)
	if err != nil {
		return Issue{}, err
	}
	if err := store.TouchTopicActivity(ctx, workspaceID, topicID, now); err != nil {
		return Issue{}, err
	}
	return created, nil
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
