package workspaceworkflow

import "strings"

// TuttiModePlanIssueIDPrefix is the deterministic Issue namespace owned by
// Tutti Mode Plan workflows. Generic Issue packages intentionally do not know
// or enforce this daemon-owned workflow identity.
const TuttiModePlanIssueIDPrefix = "tutti-mode-plan-"

func TuttiModePlanIssueID(workflowID string) (string, bool) {
	workflowID = strings.TrimSpace(workflowID)
	if workflowID == "" {
		return "", false
	}
	return TuttiModePlanIssueIDPrefix + workflowID, true
}

func IsReservedTuttiModePlanIssueID(issueID string) bool {
	return strings.HasPrefix(strings.TrimSpace(issueID), TuttiModePlanIssueIDPrefix)
}
