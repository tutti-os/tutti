package workspaceworkflow

import "testing"

func TestTuttiModePlanIssueIdentityIsWorkflowOwned(t *testing.T) {
	t.Parallel()

	if _, ok := TuttiModePlanIssueID("  "); ok {
		t.Fatal("TuttiModePlanIssueID(blank) accepted")
	}
	issueID, ok := TuttiModePlanIssueID(" workflow-1 ")
	if !ok || issueID != "tutti-mode-plan-workflow-1" {
		t.Fatalf("TuttiModePlanIssueID() = %q, %v", issueID, ok)
	}
	if !IsReservedTuttiModePlanIssueID(issueID) || IsReservedTuttiModePlanIssueID("ordinary-issue") {
		t.Fatal("reserved Tutti Mode Plan Issue namespace was not classified")
	}
}
