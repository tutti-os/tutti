// Package collabrun defines the collaboration run domain: one recorded model
// consult, fork, delegate, or handoff with full accounting (trigger, actual
// plan and model, context scope, status, duration, usage, failure, adoption).
// Consults execute daemon-side against a workspace model access plan; fork,
// delegate, and handoff runs are records linked to the target session the GUI
// creates through the existing session-create path.
package collabrun

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// Mode is the collaboration kind carried by one run.
type Mode string

const (
	// ModeConsult is a daemon-side advisory completion: advice only, no
	// tools, and never a change of task ownership.
	ModeConsult  Mode = "consult"
	ModeFork     Mode = "fork"
	ModeDelegate Mode = "delegate"
	ModeHandoff  Mode = "handoff"
)

func IsMode(value string) bool {
	switch Mode(value) {
	case ModeConsult, ModeFork, ModeDelegate, ModeHandoff:
		return true
	default:
		return false
	}
}

// TriggerSource records who initiated the collaboration.
type TriggerSource string

const (
	TriggerUser   TriggerSource = "user"
	TriggerAgent  TriggerSource = "agent"
	TriggerPolicy TriggerSource = "policy"
)

func IsTriggerSource(value string) bool {
	switch TriggerSource(value) {
	case TriggerUser, TriggerAgent, TriggerPolicy:
		return true
	default:
		return false
	}
}

// Status is the run lifecycle status.
type Status string

const (
	StatusRunning   Status = "running"
	StatusCompleted Status = "completed"
	StatusFailed    Status = "failed"
	StatusCanceled  Status = "canceled"
)

func IsStatus(value string) bool {
	switch Status(value) {
	case StatusRunning, StatusCompleted, StatusFailed, StatusCanceled:
		return true
	default:
		return false
	}
}

// Adoption records whether the run's outcome was taken up by the source task.
type Adoption string

const (
	AdoptionPending       Adoption = "pending"
	AdoptionAdopted       Adoption = "adopted"
	AdoptionRejected      Adoption = "rejected"
	AdoptionNotApplicable Adoption = "not_applicable"
)

func IsAdoption(value string) bool {
	switch Adoption(value) {
	case AdoptionPending, AdoptionAdopted, AdoptionRejected, AdoptionNotApplicable:
		return true
	default:
		return false
	}
}

// DefaultAdoption is the initial adoption state for a mode: consult and
// delegate outcomes wait for an explicit take-up decision, fork and handoff
// transfer or copy ownership so adoption does not apply.
func DefaultAdoption(mode Mode) Adoption {
	switch mode {
	case ModeConsult, ModeDelegate:
		return AdoptionPending
	default:
		return AdoptionNotApplicable
	}
}

// Usage reports provider-recorded token usage for a consult completion.
type Usage struct {
	InputTokens  int64 `json:"inputTokens"`
	OutputTokens int64 `json:"outputTokens"`
}

// Run is the durable collaboration run record. Credentials never appear on a
// run: consults resolve the plan credential at call time only.
type Run struct {
	ID            string
	WorkspaceID   string
	Mode          Mode
	TriggerSource TriggerSource
	TriggerReason string
	// SourceSessionID is the agent session the collaboration started from.
	SourceSessionID string
	// TargetSessionID is the session the GUI created for fork, delegate, and
	// handoff runs. Consults have no target session.
	TargetSessionID     string
	TargetAgentTargetID string
	// ModelPlanID and Model record the actual plan and model used.
	ModelPlanID string
	Model       string
	// ContextScope describes how much source context was carried over, for
	// example "none", "summary", or "full".
	ContextScope string
	// Prompt is the stored consult input (context plus question).
	Prompt string
	// ResultText is the consult output.
	ResultText    string
	FailureReason string
	Status        Status
	Adoption      Adoption
	Usage         Usage
	StartedAt     time.Time
	CompletedAt   time.Time
	DurationMs    int64
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

var ErrInvalidRun = errors.New("invalid collaboration run")

// Normalize validates and canonicalizes a run record.
func Normalize(run Run) (Run, error) {
	run.ID = strings.TrimSpace(run.ID)
	run.WorkspaceID = strings.TrimSpace(run.WorkspaceID)
	run.TriggerReason = strings.TrimSpace(run.TriggerReason)
	run.SourceSessionID = strings.TrimSpace(run.SourceSessionID)
	run.TargetSessionID = strings.TrimSpace(run.TargetSessionID)
	run.TargetAgentTargetID = strings.TrimSpace(run.TargetAgentTargetID)
	run.ModelPlanID = strings.TrimSpace(run.ModelPlanID)
	run.Model = strings.TrimSpace(run.Model)
	run.ContextScope = strings.TrimSpace(run.ContextScope)
	if run.ID == "" {
		return Run{}, fmt.Errorf("%w: id is required", ErrInvalidRun)
	}
	if run.WorkspaceID == "" {
		return Run{}, fmt.Errorf("%w: workspace id is required", ErrInvalidRun)
	}
	if !IsMode(string(run.Mode)) {
		return Run{}, fmt.Errorf("%w: mode is unsupported", ErrInvalidRun)
	}
	if !IsTriggerSource(string(run.TriggerSource)) {
		return Run{}, fmt.Errorf("%w: trigger source is unsupported", ErrInvalidRun)
	}
	if run.Status == "" {
		run.Status = StatusRunning
	}
	if !IsStatus(string(run.Status)) {
		return Run{}, fmt.Errorf("%w: status is unsupported", ErrInvalidRun)
	}
	if run.Adoption == "" {
		run.Adoption = DefaultAdoption(run.Mode)
	}
	if !IsAdoption(string(run.Adoption)) {
		return Run{}, fmt.Errorf("%w: adoption is unsupported", ErrInvalidRun)
	}
	return run, nil
}
