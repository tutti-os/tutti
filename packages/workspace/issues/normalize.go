package workspaceissues

import "strings"

func NormalizeStatus(raw string) (Status, bool) {
	switch Status(strings.ToLower(strings.TrimSpace(raw))) {
	case StatusNotStarted, StatusRunning, StatusPendingAcceptance, StatusCompleted, StatusFailed, StatusCanceled:
		return Status(strings.ToLower(strings.TrimSpace(raw))), true
	default:
		return "", false
	}
}

func NormalizeRunCompletionStatus(raw string) (Status, bool) {
	switch Status(strings.ToLower(strings.TrimSpace(raw))) {
	case StatusCompleted, StatusFailed, StatusCanceled:
		return Status(strings.ToLower(strings.TrimSpace(raw))), true
	default:
		return "", false
	}
}

func NormalizePriority(raw string) Priority {
	switch Priority(strings.ToLower(strings.TrimSpace(raw))) {
	case PriorityHigh, PriorityMedium, PriorityLow:
		return Priority(strings.ToLower(strings.TrimSpace(raw)))
	default:
		return PriorityMedium
	}
}

func TaskStatusForCompletedRun(status Status) Status {
	if status == StatusCompleted {
		return StatusPendingAcceptance
	}
	return status
}

func ProjectIssueStatus(counts StatusCounts) Status {
	switch {
	case counts.Running > 0:
		return StatusRunning
	case counts.Failed > 0:
		return StatusFailed
	case counts.All == 0 || counts.NotStarted == counts.All:
		return StatusNotStarted
	case counts.All > 0 && counts.Completed == counts.All:
		return StatusCompleted
	case counts.All > 0 && counts.PendingAcceptance > 0 && counts.NotStarted == 0 && counts.Running == 0 && counts.Failed == 0:
		return StatusPendingAcceptance
	case counts.All > 0 && counts.Canceled == counts.All:
		return StatusCanceled
	default:
		return StatusRunning
	}
}

func NormalizeContextRefParentKind(raw string) (ContextRefParentKind, bool) {
	switch ContextRefParentKind(strings.ToLower(strings.TrimSpace(raw))) {
	case ContextRefParentIssue, ContextRefParentTask:
		return ContextRefParentKind(strings.ToLower(strings.TrimSpace(raw))), true
	default:
		return "", false
	}
}

func TrimSearchText(content string) string {
	return strings.TrimSpace(content)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
