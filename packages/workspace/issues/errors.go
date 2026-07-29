package workspaceissues

import (
	"errors"
	"fmt"
	"strings"
)

var (
	ErrContextRefAlreadyExists    = errors.New("issue context reference already exists")
	ErrContextRefNotFound         = errors.New("issue context reference not found")
	ErrInvalidArgument            = errors.New("issue manager argument is invalid")
	ErrIssueAlreadyExists         = errors.New("issue already exists")
	ErrIssueNotFound              = errors.New("issue not found")
	ErrIssueBudgetSoftLimited     = errors.New("issue budget is soft limited")
	ErrRunAlreadyExists           = errors.New("issue task run already exists")
	ErrRunNotFound                = errors.New("issue task run not found")
	ErrStoreNotConfigured         = errors.New("issue manager store is not configured")
	ErrTaskAlreadyExists          = errors.New("issue task already exists")
	ErrTaskNotFound               = errors.New("issue task not found")
	ErrTaskDependenciesIncomplete = errors.New("issue task dependencies are incomplete")
	ErrTopicAlreadyExists         = errors.New("issue topic already exists")
	ErrTopicNotEmpty              = errors.New("issue topic is not empty")
	ErrTopicNotFound              = errors.New("issue topic not found")
	ErrWorkspaceNotFound          = errors.New("workspace not found")
	ErrManagedIssueMutation       = errors.New("tutti-owned issue is managed by its source conversation")
)

// ManagedIssueMutationError rejects generic graph mutations for a Tutti-owned
// Issue while preserving the exact source-conversation recovery target.
type ManagedIssueMutationError struct {
	IssueID         string
	SourceSessionID string
}

func (err *ManagedIssueMutationError) Error() string {
	if err == nil {
		return ErrManagedIssueMutation.Error()
	}
	return fmt.Sprintf("%s: issue %s", ErrManagedIssueMutation, err.IssueID)
}

func (*ManagedIssueMutationError) Unwrap() error {
	return ErrManagedIssueMutation
}

func (err *ManagedIssueMutationError) ManagedIssueID() string {
	if err == nil {
		return ""
	}
	return err.IssueID
}

func (err *ManagedIssueMutationError) ManagedSourceSessionID() string {
	if err == nil {
		return ""
	}
	return err.SourceSessionID
}

// RejectManagedIssueMutation is the reusable graph-mutation admission rule.
// Product orchestration uses its own source-scoped transaction and never
// exposes a boolean bypass through generic Issue Manager inputs.
func RejectManagedIssueMutation(issue Issue) error {
	if issue.PlanningSource != PlanningSourceTuttiModePlan {
		return nil
	}
	return &ManagedIssueMutationError{
		IssueID:         strings.TrimSpace(issue.IssueID),
		SourceSessionID: strings.TrimSpace(issue.SourceSessionID),
	}
}
