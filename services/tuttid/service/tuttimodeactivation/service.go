// Package tuttimodeactivation orchestrates the independent, durable Tutti
// mode activation attached to an agent session. It deliberately does not infer
// activation from capability references or provider collaboration state.
package tuttimodeactivation

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	activationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

var (
	ErrInvalidInput            = errors.New("invalid Tutti mode activation input")
	ErrRevisionConflict        = errors.New("tutti mode activation revision conflict")
	ErrServiceUnavailable      = errors.New("tutti mode activation service is unavailable")
	ErrTurnSnapshotNotFound    = errors.New("tutti mode turn snapshot not found")
	ErrTurnSnapshotNotAccepted = errors.New("tutti mode turn snapshot acceptance is not durable")
	// ErrTuttiModeDisabled rejects writes while the lab.tuttiMode feature flag
	// is off. Reads and turn-snapshot lifecycle stay available so existing
	// activations keep working.
	ErrTuttiModeDisabled = errors.New("tutti mode is disabled by the lab.tuttiMode feature flag")
)

// TuttiModeFeatureFlag is the desktop preferences feature-flag key that gates
// Tutti Mode writes. Alias of the shared lab-flag catalog key.
const TuttiModeFeatureFlag = preferencesbiz.LabFlagTuttiMode

type Store interface {
	GetTuttiModeActivation(context.Context, string, string) (activationbiz.Activation, bool, error)
	ListTuttiModeActivations(context.Context, string, []string) (map[string]activationbiz.Activation, error)
	SetTuttiModeActivation(context.Context, workspacedata.SetTuttiModeActivationInput) (activationbiz.Activation, bool, error)
	GetTuttiModeTurnSnapshot(context.Context, string, string, string) (activationbiz.TurnSnapshot, bool, error)
	PutTuttiModeTurnSnapshot(context.Context, string, string, string, activationbiz.TurnSnapshot, time.Time) (activationbiz.TurnSnapshot, bool, error)
	AcceptTuttiModeTurnSnapshot(context.Context, string, string, string, time.Time) (bool, error)
	IsTuttiModeTurnSnapshotAccepted(context.Context, string, string, string) (bool, error)
	AbandonTuttiModeTurnSnapshot(context.Context, string, string, string, activationbiz.TurnSnapshot) (bool, error)
	DeleteTuttiModeActivationSessionState(context.Context, string, string) error
}

type Publisher interface {
	PublishTuttiModeActivationUpdated(context.Context, activationbiz.Update) error
}

type Service struct {
	Store     Store
	Publisher Publisher
	// FeatureFlags reads the desktop preferences feature-flag map. Nil keeps
	// every write allowed (tests and minimal embedders); when set, writes are
	// rejected with ErrTuttiModeDisabled unless lab.tuttiMode is true.
	FeatureFlags func(context.Context) (map[string]bool, error)
	Now          func() time.Time
	NewID        func() string
}

type SetInput struct {
	WorkspaceID    string
	AgentSessionID string
	State          activationbiz.State
	Source         activationbiz.Source
	// OrchestrationIntensity is optional. Nil keeps the current revision's
	// value (or the default for the first revision); a value appends a new
	// revision when it differs from the current one.
	OrchestrationIntensity *int
	ExpectedRevision       *int64
}

type SetResult struct {
	Activation *activationbiz.Activation
	Changed    bool
}

func (s *Service) Get(ctx context.Context, workspaceID, agentSessionID string) (*activationbiz.Activation, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	workspaceID, agentSessionID, err := normalizeIdentity(workspaceID, agentSessionID)
	if err != nil {
		return nil, err
	}
	activation, ok, err := s.Store.GetTuttiModeActivation(ctx, workspaceID, agentSessionID)
	if err != nil || !ok {
		return nil, err
	}
	return cloneActivation(activation), nil
}

func (s *Service) List(ctx context.Context, workspaceID string, agentSessionIDs []string) (map[string]activationbiz.Activation, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return nil, fmt.Errorf("%w: workspace id is required", ErrInvalidInput)
	}
	ids := make([]string, 0, len(agentSessionIDs))
	for _, value := range agentSessionIDs {
		if value = strings.TrimSpace(value); value != "" {
			ids = append(ids, value)
		}
	}
	return s.Store.ListTuttiModeActivations(ctx, workspaceID, ids)
}

func (s *Service) Set(ctx context.Context, input SetInput) (SetResult, error) {
	if err := s.ready(); err != nil {
		return SetResult{}, err
	}
	if err := s.requireTuttiModeEnabled(ctx); err != nil {
		return SetResult{}, err
	}
	workspaceID, agentSessionID, err := normalizeIdentity(input.WorkspaceID, input.AgentSessionID)
	if err != nil {
		return SetResult{}, err
	}
	if !activationbiz.IsState(input.State) || !activationbiz.IsSource(input.Source) {
		return SetResult{}, fmt.Errorf("%w: status and source are required", ErrInvalidInput)
	}
	if input.State == activationbiz.StateActive && input.Source != activationbiz.SourceSlashCommand ||
		input.State == activationbiz.StateInactive && input.Source != activationbiz.SourceBadgeRemove {
		return SetResult{}, fmt.Errorf("%w: status and source do not describe one user activation transition", ErrInvalidInput)
	}
	if input.OrchestrationIntensity != nil && !activationbiz.IsOrchestrationIntensity(*input.OrchestrationIntensity) {
		return SetResult{}, fmt.Errorf("%w: orchestration intensity must be between 0 and 100", ErrInvalidInput)
	}
	now := s.now()
	activation, changed, err := s.Store.SetTuttiModeActivation(ctx, workspacedata.SetTuttiModeActivationInput{
		WorkspaceID:            workspaceID,
		AgentSessionID:         agentSessionID,
		ActivationID:           s.newID(),
		RevisionID:             s.newID(),
		ExpectedRevision:       cloneInt64Pointer(input.ExpectedRevision),
		State:                  input.State,
		Source:                 input.Source,
		OrchestrationIntensity: cloneIntPointer(input.OrchestrationIntensity),
		ChangedAt:              now,
	})
	if errors.Is(err, workspacedata.ErrTuttiModeActivationRevisionConflict) {
		return SetResult{}, ErrRevisionConflict
	}
	if err != nil {
		return SetResult{}, err
	}
	if !changed && activation.ID == "" {
		return SetResult{Changed: false}, nil
	}
	result := SetResult{Activation: cloneActivation(activation), Changed: changed}
	if changed {
		s.publish(ctx, activationbiz.Update{
			WorkspaceID:    activation.WorkspaceID,
			AgentSessionID: activation.AgentSessionID,
			ActivationID:   activation.ID,
			Revision:       activation.CurrentRevision.Revision,
			State:          activation.CurrentRevision.State,
			ChangeKind:     changeKindForState(activation.CurrentRevision.State),
		})
	}
	return result, nil
}

// SnapshotForNewTurn returns the current activation revision, including an
// explicit inactive snapshot for sessions that have never been activated.
func (s *Service) SnapshotForNewTurn(ctx context.Context, workspaceID, agentSessionID string) (activationbiz.TurnSnapshot, error) {
	activation, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		return activationbiz.TurnSnapshot{}, err
	}
	return activationbiz.SnapshotFromActivation(activation), nil
}

// ExistingTurnSnapshot never consults current activation state. This keeps an
// active turn stable when guidance arrives after the user changes the badge.
func (s *Service) ExistingTurnSnapshot(ctx context.Context, workspaceID, agentSessionID, turnID string) (activationbiz.TurnSnapshot, error) {
	if err := s.ready(); err != nil {
		return activationbiz.TurnSnapshot{}, err
	}
	workspaceID, agentSessionID, err := normalizeIdentity(workspaceID, agentSessionID)
	turnID = strings.TrimSpace(turnID)
	if err != nil || turnID == "" {
		return activationbiz.TurnSnapshot{}, fmt.Errorf("%w: workspace, session, and turn ids are required", ErrInvalidInput)
	}
	snapshot, ok, err := s.Store.GetTuttiModeTurnSnapshot(ctx, workspaceID, agentSessionID, turnID)
	if err != nil {
		return activationbiz.TurnSnapshot{}, err
	}
	if !ok {
		return activationbiz.TurnSnapshot{}, fmt.Errorf(
			"%w: workspace %q session %q turn %q",
			ErrTurnSnapshotNotFound,
			workspaceID,
			agentSessionID,
			turnID,
		)
	}
	return snapshot, nil
}

// BindTurnSnapshot is first-write-wins. A repeated call returns the original
// snapshot so retry races cannot rewrite the semantic input of a turn.
func (s *Service) BindTurnSnapshot(ctx context.Context, workspaceID, agentSessionID, turnID string, snapshot activationbiz.TurnSnapshot) (activationbiz.TurnSnapshot, bool, error) {
	if err := s.ready(); err != nil {
		return activationbiz.TurnSnapshot{}, false, err
	}
	workspaceID, agentSessionID, err := normalizeIdentity(workspaceID, agentSessionID)
	turnID = strings.TrimSpace(turnID)
	if err != nil || turnID == "" {
		return activationbiz.TurnSnapshot{}, false, fmt.Errorf("%w: workspace, session, and turn ids are required", ErrInvalidInput)
	}
	return s.Store.PutTuttiModeTurnSnapshot(ctx, workspaceID, agentSessionID, turnID, snapshot, s.now())
}

func (s *Service) AcceptTurnSnapshot(ctx context.Context, workspaceID, agentSessionID, turnID string) (bool, error) {
	if err := s.ready(); err != nil {
		return false, err
	}
	workspaceID, agentSessionID, err := normalizeIdentity(workspaceID, agentSessionID)
	turnID = strings.TrimSpace(turnID)
	if err != nil || turnID == "" {
		return false, fmt.Errorf("%w: workspace, session, and turn ids are required", ErrInvalidInput)
	}
	changed, err := s.Store.AcceptTuttiModeTurnSnapshot(ctx, workspaceID, agentSessionID, turnID, s.now())
	if err != nil {
		return false, err
	}
	accepted, err := s.Store.IsTuttiModeTurnSnapshotAccepted(ctx, workspaceID, agentSessionID, turnID)
	if err != nil {
		return false, err
	}
	if accepted {
		return changed, nil
	}
	_, exists, err := s.Store.GetTuttiModeTurnSnapshot(ctx, workspaceID, agentSessionID, turnID)
	if err != nil {
		return false, err
	}
	if !exists {
		return false, fmt.Errorf("%w: turn %q", ErrTurnSnapshotNotFound, turnID)
	}
	return false, fmt.Errorf("%w: turn %q", ErrTurnSnapshotNotAccepted, turnID)
}

func (s *Service) AbandonTurnSnapshot(ctx context.Context, workspaceID, agentSessionID, turnID string, snapshot activationbiz.TurnSnapshot) (bool, error) {
	if err := s.ready(); err != nil {
		return false, err
	}
	workspaceID, agentSessionID, err := normalizeIdentity(workspaceID, agentSessionID)
	turnID = strings.TrimSpace(turnID)
	if err != nil || turnID == "" {
		return false, fmt.Errorf("%w: workspace, session, and turn ids are required", ErrInvalidInput)
	}
	return s.Store.AbandonTuttiModeTurnSnapshot(ctx, workspaceID, agentSessionID, turnID, snapshot)
}

func (s *Service) DeleteSessionState(ctx context.Context, workspaceID, agentSessionID string) error {
	if err := s.ready(); err != nil {
		return err
	}
	workspaceID, agentSessionID, err := normalizeIdentity(workspaceID, agentSessionID)
	if err != nil {
		return err
	}
	return s.Store.DeleteTuttiModeActivationSessionState(ctx, workspaceID, agentSessionID)
}

func (s *Service) ready() error {
	if s == nil || s.Store == nil {
		return ErrServiceUnavailable
	}
	return nil
}

// requireTuttiModeEnabled enforces the lab.tuttiMode write gate. A flag-read
// failure fails closed for writes: the durable state is unchanged either way,
// and a misconfigured gate must not silently open the feature.
func (s *Service) requireTuttiModeEnabled(ctx context.Context) error {
	if s.FeatureFlags == nil {
		return nil
	}
	flags, err := s.FeatureFlags(ctx)
	if err != nil {
		return fmt.Errorf("read tutti mode feature flag: %w", err)
	}
	if !preferencesbiz.IsLabFlagEnabled(flags, TuttiModeFeatureFlag) {
		return ErrTuttiModeDisabled
	}
	return nil
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *Service) newID() string {
	if s.NewID != nil {
		return strings.TrimSpace(s.NewID())
	}
	return uuid.NewString()
}

func (s *Service) publish(ctx context.Context, update activationbiz.Update) {
	if s.Publisher != nil {
		// Durable state is authoritative. Reconnect performs a GET projection, so
		// a transient invalidation failure must not make a committed mutation look
		// retryable.
		_ = s.Publisher.PublishTuttiModeActivationUpdated(ctx, update)
	}
}

func normalizeIdentity(workspaceID, agentSessionID string) (string, string, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return "", "", fmt.Errorf("%w: workspace and agent session ids are required", ErrInvalidInput)
	}
	return workspaceID, agentSessionID, nil
}

func changeKindForState(state activationbiz.State) activationbiz.ChangeKind {
	if state == activationbiz.StateActive {
		return activationbiz.ChangeKindActivated
	}
	return activationbiz.ChangeKindDeactivated
}

func cloneActivation(value activationbiz.Activation) *activationbiz.Activation {
	cloned := value
	return &cloned
}

func cloneInt64Pointer(value *int64) *int64 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func cloneIntPointer(value *int) *int {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}
