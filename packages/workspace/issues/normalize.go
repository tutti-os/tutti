package workspaceissues

import (
	"math"
	"slices"
	"strings"
)

const (
	DefaultReasoningIntensity     = 50
	DefaultOrchestrationIntensity = 50
	DefaultQuotaWaterlinePercent  = 10
	minimumAutoTokenBudget        = int64(32_000)
	maximumAutoTokenBudget        = int64(2_000_000)
)

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

func NormalizePlanningSource(raw string) (PlanningSource, bool) {
	switch PlanningSource(strings.ToLower(strings.TrimSpace(raw))) {
	case PlanningSourceManual, PlanningSourceTuttiModePlan, PlanningSourceTraditionalPlan:
		return PlanningSource(strings.ToLower(strings.TrimSpace(raw))), true
	default:
		return "", false
	}
}

func DefaultExecutionProfile() ExecutionProfile {
	return ExecutionProfile{
		ReasoningIntensity:     DefaultReasoningIntensity,
		OrchestrationIntensity: DefaultOrchestrationIntensity,
	}
}

func NormalizeExecutionProfile(profile ExecutionProfile) (ExecutionProfile, bool) {
	if profile.ReasoningIntensity < 0 || profile.ReasoningIntensity > 100 ||
		profile.OrchestrationIntensity < 0 || profile.OrchestrationIntensity > 100 {
		return ExecutionProfile{}, false
	}
	return profile, true
}

func DefaultBudget() Budget {
	return Budget{
		Mode:                  BudgetModeAuto,
		QuotaWaterlinePercent: DefaultQuotaWaterlinePercent,
		Status:                BudgetStatusActive,
	}
}

func NormalizeBudget(value Budget) (Budget, bool) {
	value.Mode = BudgetMode(strings.ToLower(strings.TrimSpace(string(value.Mode))))
	if value.Mode == "" {
		value.Mode = BudgetModeAuto
	}
	if value.Status == "" {
		value.Status = BudgetStatusActive
	} else {
		value.Status = BudgetStatus(strings.ToLower(strings.TrimSpace(string(value.Status))))
	}
	if value.TokenLimit < 0 || value.ConsumedTokens < 0 || !finitePercentage(value.QuotaWaterlinePercent) ||
		!finiteNumber(value.RemainingQuotaPercent) ||
		value.HasRemainingQuota && !finitePercentage(value.RemainingQuotaPercent) {
		return Budget{}, false
	}
	switch value.Mode {
	case BudgetModeAuto:
		// The compiler owns the effective limit in auto mode.
		value.TokenLimit = maxInt64(value.TokenLimit, 0)
	case BudgetModeFixed:
		if value.TokenLimit <= 0 {
			return Budget{}, false
		}
	default:
		return Budget{}, false
	}
	switch value.Status {
	case BudgetStatusActive, BudgetStatusSoftLimited:
	default:
		return Budget{}, false
	}
	return value, true
}

func finitePercentage(value float64) bool {
	return finiteNumber(value) && value >= 0 && value <= 100
}

func finiteNumber(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func CompileAutoTokenBudget(taskCount int, profile ExecutionProfile) int64 {
	if taskCount < 1 {
		taskCount = 1
	}
	compiled := int64(16_000) + int64(taskCount)*CompileEstimatedRunTokenBudget(profile)
	if compiled < minimumAutoTokenBudget {
		return minimumAutoTokenBudget
	}
	if compiled > maximumAutoTokenBudget {
		return maximumAutoTokenBudget
	}
	return compiled
}

// CompileEstimatedRunTokenBudget returns the conservative allowance reserved
// before one automatic Issue task is dispatched. Keeping this compiler aligned
// with CompileAutoTokenBudget lets lowering the Issue intensities make a
// previously blocked remaining task fit without silently increasing a fixed
// token limit.
func CompileEstimatedRunTokenBudget(profile ExecutionProfile) int64 {
	return 24_000 + int64(profile.ReasoningIntensity)*320 + int64(profile.OrchestrationIntensity)*160
}

// IssueBudgetAllowsNextAutomaticRun applies the pre-dispatch soft gate. It
// reserves an estimated allowance instead of waiting until actual usage has
// already crossed the limit, which makes the documented lower-intensity
// recovery path meaningful.
func IssueBudgetAllowsNextAutomaticRun(issue Issue) bool {
	if issue.Budget.Status != BudgetStatusActive {
		return false
	}
	if issue.Budget.HasRemainingQuota && issue.Budget.RemainingQuotaPercent <= issue.Budget.QuotaWaterlinePercent {
		return false
	}
	if issue.Budget.TokenLimit <= 0 {
		return true
	}
	remaining := issue.Budget.TokenLimit - issue.Budget.ConsumedTokens
	return remaining >= CompileEstimatedRunTokenBudget(issue.ExecutionProfile)
}

// CompileAutoTokenBudgetWithHistory blends the deterministic scale/intensity
// compiler with the observed total usage of comparable completed tasks. The
// deterministic result remains the fallback and contributes half the result,
// so one unusual historical run cannot wholly redefine a new Issue budget.
func CompileAutoTokenBudgetWithHistory(taskCount int, profile ExecutionProfile, historicalTotalTokens int64) int64 {
	compiled := CompileAutoTokenBudget(taskCount, profile)
	if historicalTotalTokens <= 0 {
		return compiled
	}
	historicalWithHeadroom := historicalTotalTokens + historicalTotalTokens/4
	if historicalWithHeadroom < minimumAutoTokenBudget {
		historicalWithHeadroom = minimumAutoTokenBudget
	}
	if historicalWithHeadroom > maximumAutoTokenBudget {
		historicalWithHeadroom = maximumAutoTokenBudget
	}
	blended := compiled/2 + historicalWithHeadroom/2
	if blended < minimumAutoTokenBudget {
		return minimumAutoTokenBudget
	}
	if blended > maximumAutoTokenBudget {
		return maximumAutoTokenBudget
	}
	return blended
}

func NormalizeAcceptanceState(raw string) (AcceptanceState, bool) {
	switch AcceptanceState(strings.ToLower(strings.TrimSpace(raw))) {
	case AcceptanceAgentClaimed, AcceptanceAutoChecked, AcceptanceUserAccepted:
		return AcceptanceState(strings.ToLower(strings.TrimSpace(raw))), true
	default:
		return "", false
	}
}

func CanTransitionAcceptance(current AcceptanceState, next AcceptanceState) bool {
	if current == next {
		return true
	}
	switch current {
	case AcceptanceAgentClaimed:
		return next == AcceptanceAutoChecked || next == AcceptanceUserAccepted
	case AcceptanceAutoChecked:
		return next == AcceptanceUserAccepted
	default:
		return false
	}
}

func NormalizeDependencyTaskIDs(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func ValidateTaskDependencyGraph(tasks []Task) bool {
	byID := make(map[string]Task, len(tasks))
	for _, task := range tasks {
		if task.TaskID == "" {
			return false
		}
		byID[task.TaskID] = task
	}
	visiting := make(map[string]bool, len(tasks))
	visited := make(map[string]bool, len(tasks))
	var visit func(string) bool
	visit = func(taskID string) bool {
		if visiting[taskID] {
			return false
		}
		if visited[taskID] {
			return true
		}
		task, exists := byID[taskID]
		if !exists {
			return false
		}
		visiting[taskID] = true
		for _, dependencyID := range task.DependencyTaskIDs {
			if dependencyID == taskID || !visit(dependencyID) {
				return false
			}
		}
		visiting[taskID] = false
		visited[taskID] = true
		return true
	}
	ids := make([]string, 0, len(byID))
	for taskID := range byID {
		ids = append(ids, taskID)
	}
	slices.Sort(ids)
	for _, taskID := range ids {
		if !visit(taskID) {
			return false
		}
	}
	return true
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

func NormalizeTokenUsage(value TokenUsage) (TokenUsage, bool) {
	if value.InputTokens < 0 || value.OutputTokens < 0 || value.CacheReadTokens < 0 || value.CacheWriteTokens < 0 {
		return TokenUsage{}, false
	}
	return value, true
}

func maxInt(left int, right int) int {
	if left > right {
		return left
	}
	return right
}
