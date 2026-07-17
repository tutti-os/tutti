// Package tuttimodeactivation owns the durable user activation state for
// Tutti mode. It is independent from provider collaboration modes and from
// the WorkspaceWorkflow/TuttiModePlan proposal lifecycle.
package tuttimodeactivation

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrInvalidActivation = errors.New("invalid Tutti mode activation")

// DefaultOrchestrationIntensity mirrors the Issue-domain default so an
// activation without an explicit slider interaction still carries a usable
// planning strength.
const DefaultOrchestrationIntensity = 50

// IsOrchestrationIntensity reports whether the value is inside the inclusive
// 0-100 slider range.
func IsOrchestrationIntensity(value int) bool {
	return value >= 0 && value <= 100
}

type State string

const (
	StateActive   State = "active"
	StateInactive State = "inactive"
)

func IsState(value State) bool {
	return value == StateActive || value == StateInactive
}

type Source string

const (
	SourceSlashCommand Source = "slash_command"
	SourceBadgeRemove  Source = "badge_remove"
)

func IsSource(value Source) bool {
	return value == SourceSlashCommand || value == SourceBadgeRemove
}

type Revision struct {
	ID           string
	ActivationID string
	Revision     int64
	State        State
	Source       Source
	// OrchestrationIntensity is the session-scoped planning strength captured
	// with this revision. It evolves through ordinary activation revisions.
	OrchestrationIntensity int
	CreatedAt              time.Time
}

type Activation struct {
	ID              string
	WorkspaceID     string
	AgentSessionID  string
	CurrentRevision Revision
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// TurnSnapshot is the immutable Tutti mode state supplied to one provider
// turn. An unconfigured session is represented explicitly as inactive with
// empty activation/revision identity and revision zero.
type TurnSnapshot struct {
	ActivationID string
	RevisionID   string
	Revision     int64
	State        State
	Source       Source
	// OrchestrationIntensity is copied from the exact activation revision the
	// turn observed. The canonical unconfigured snapshot uses zero.
	OrchestrationIntensity int
}

type ChangeKind string

const (
	ChangeKindActivated   ChangeKind = "activated"
	ChangeKindDeactivated ChangeKind = "deactivated"
)

type Update struct {
	WorkspaceID    string
	AgentSessionID string
	ActivationID   string
	Revision       int64
	State          State
	ChangeKind     ChangeKind
}

func NormalizeActivation(value Activation) (Activation, error) {
	value.ID = strings.TrimSpace(value.ID)
	value.WorkspaceID = strings.TrimSpace(value.WorkspaceID)
	value.AgentSessionID = strings.TrimSpace(value.AgentSessionID)
	if value.ID == "" || value.WorkspaceID == "" || value.AgentSessionID == "" {
		return Activation{}, fmt.Errorf("%w: activation, workspace, and agent session ids are required", ErrInvalidActivation)
	}
	revision, err := NormalizeRevision(value.CurrentRevision)
	if err != nil {
		return Activation{}, err
	}
	if revision.ActivationID != value.ID {
		return Activation{}, fmt.Errorf("%w: current revision must belong to activation", ErrInvalidActivation)
	}
	if value.CreatedAt.IsZero() || value.UpdatedAt.IsZero() || value.UpdatedAt.Before(value.CreatedAt) {
		return Activation{}, fmt.Errorf("%w: valid timestamps are required", ErrInvalidActivation)
	}
	value.CurrentRevision = revision
	value.CreatedAt = value.CreatedAt.UTC()
	value.UpdatedAt = value.UpdatedAt.UTC()
	return value, nil
}

func NormalizeRevision(value Revision) (Revision, error) {
	value.ID = strings.TrimSpace(value.ID)
	value.ActivationID = strings.TrimSpace(value.ActivationID)
	value.State = State(strings.TrimSpace(string(value.State)))
	value.Source = Source(strings.TrimSpace(string(value.Source)))
	if value.ID == "" || value.ActivationID == "" || value.Revision <= 0 || value.CreatedAt.IsZero() {
		return Revision{}, fmt.Errorf("%w: complete revision identity and timestamp are required", ErrInvalidActivation)
	}
	if !IsState(value.State) || !IsSource(value.Source) {
		return Revision{}, fmt.Errorf("%w: unsupported state or source", ErrInvalidActivation)
	}
	if value.State == StateActive && value.Source != SourceSlashCommand {
		return Revision{}, fmt.Errorf("%w: active state must originate from slash command", ErrInvalidActivation)
	}
	if value.State == StateInactive && value.Source != SourceBadgeRemove {
		return Revision{}, fmt.Errorf("%w: inactive state must originate from badge removal", ErrInvalidActivation)
	}
	if !IsOrchestrationIntensity(value.OrchestrationIntensity) {
		return Revision{}, fmt.Errorf("%w: orchestration intensity must be between 0 and 100", ErrInvalidActivation)
	}
	value.CreatedAt = value.CreatedAt.UTC()
	return value, nil
}

func NormalizeTurnSnapshot(value TurnSnapshot) (TurnSnapshot, error) {
	value.ActivationID = strings.TrimSpace(value.ActivationID)
	value.RevisionID = strings.TrimSpace(value.RevisionID)
	value.State = State(strings.TrimSpace(string(value.State)))
	value.Source = Source(strings.TrimSpace(string(value.Source)))
	if value.ActivationID == "" && value.RevisionID == "" && value.Revision == 0 {
		if value.State == StateInactive && value.Source == "" && value.OrchestrationIntensity == 0 {
			return value, nil
		}
		return TurnSnapshot{}, fmt.Errorf("%w: unconfigured snapshot must be explicitly inactive", ErrInvalidActivation)
	}
	if value.ActivationID == "" || value.RevisionID == "" || value.Revision <= 0 {
		return TurnSnapshot{}, fmt.Errorf("%w: complete snapshot revision identity is required", ErrInvalidActivation)
	}
	if !IsState(value.State) || !IsSource(value.Source) {
		return TurnSnapshot{}, fmt.Errorf("%w: unsupported snapshot state or source", ErrInvalidActivation)
	}
	if value.State == StateActive && value.Source != SourceSlashCommand {
		return TurnSnapshot{}, fmt.Errorf("%w: active snapshot must originate from slash command", ErrInvalidActivation)
	}
	if value.State == StateInactive && value.Source != SourceBadgeRemove {
		return TurnSnapshot{}, fmt.Errorf("%w: inactive snapshot must originate from badge removal", ErrInvalidActivation)
	}
	if !IsOrchestrationIntensity(value.OrchestrationIntensity) {
		return TurnSnapshot{}, fmt.Errorf("%w: orchestration intensity must be between 0 and 100", ErrInvalidActivation)
	}
	return value, nil
}

func SnapshotFromActivation(value *Activation) TurnSnapshot {
	if value == nil {
		return TurnSnapshot{State: StateInactive}
	}
	return TurnSnapshot{
		ActivationID:           value.ID,
		RevisionID:             value.CurrentRevision.ID,
		Revision:               value.CurrentRevision.Revision,
		State:                  value.CurrentRevision.State,
		Source:                 value.CurrentRevision.Source,
		OrchestrationIntensity: value.CurrentRevision.OrchestrationIntensity,
	}
}
