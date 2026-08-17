package agentstatus

import (
	"sync"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerstatus"
)

// RunOutcomeStore remembers the latest provider-backed authentication evidence
// from a real agent run. Local marker files and `auth status` commands only prove
// that credentials are configured; a successful provider request promotes that
// state to authenticated, while an authentication failure demotes it to required.
//
// Each fact carries its observation time. Once a credential file is rewritten
// by a fresh login, older provider-backed evidence is dropped before the local
// state is reduced again.
//
// It is a pointer so it survives the value-copies of Service: the runtime and the
// status probe share one store.
type RunOutcomeStore struct {
	mu           sync.RWMutex
	authEvidence map[string]runAuthEvidence
}

func NewRunOutcomeStore() *RunOutcomeStore {
	return &RunOutcomeStore{authEvidence: map[string]runAuthEvidence{}}
}

type runAuthEvidence struct {
	evidence   providerstatus.AuthEvidence
	observedAt time.Time
}

// RecordAuthFailure marks a provider's login as invalidated by a runtime
// authentication failure (e.g. a 401 when sending a message or on a trial run),
// stamping the moment it was observed.
func (s *RunOutcomeStore) RecordAuthFailure(provider string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.authEvidence == nil {
		s.authEvidence = map[string]runAuthEvidence{}
	}
	s.authEvidence[provider] = runAuthEvidence{
		evidence: providerstatus.AuthEvidence{
			Kind:   providerstatus.AuthEvidenceRemoteAuthFailure,
			Reason: providerstatus.AuthReasonAuthRequired,
		},
		observedAt: time.Now(),
	}
}

// RecordSuccess replaces any older failure with strong positive evidence from
// a real provider request.
func (s *RunOutcomeStore) RecordSuccess(provider string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.authEvidence == nil {
		s.authEvidence = map[string]runAuthEvidence{}
	}
	s.authEvidence[provider] = runAuthEvidence{
		evidence:   providerstatus.AuthEvidence{Kind: providerstatus.AuthEvidenceRemoteSuccess},
		observedAt: time.Now(),
	}
}

// ClearAuthInvalidated is retained for callers that clear stale auth state after
// login. It clears either positive or negative provider-backed evidence.
func (s *RunOutcomeStore) ClearAuthInvalidated(provider string) {
	s.ClearAuthEvidence(provider)
}

// ClearAuthEvidence drops provider-backed evidence after credentials change.
func (s *RunOutcomeStore) ClearAuthEvidence(provider string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.authEvidence, provider)
}

// AuthInvalidated reports whether a recent run authentication failure means the
// provider should be treated as needing login.
func (s *RunOutcomeStore) AuthInvalidated(provider string) bool {
	_, ok := s.AuthInvalidatedSince(provider)
	return ok
}

// AuthInvalidatedSince returns the time a provider's last runtime auth failure was
// recorded, and whether one is currently outstanding. The caller compares it
// against the credential file's mtime to decide whether a fresh login has since
// healed the failure.
func (s *RunOutcomeStore) AuthInvalidatedSince(provider string) (time.Time, bool) {
	evidence, observedAt, ok := s.AuthEvidence(provider)
	if !ok || evidence.Kind != providerstatus.AuthEvidenceRemoteAuthFailure {
		return time.Time{}, false
	}
	return observedAt, true
}

// AuthEvidence returns the latest provider-backed authentication fact for a
// runtime. Credential changes explicitly clear it at the status-service layer.
func (s *RunOutcomeStore) AuthEvidence(provider string) (providerstatus.AuthEvidence, time.Time, bool) {
	if s == nil {
		return providerstatus.AuthEvidence{}, time.Time{}, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.authEvidence[provider]
	return record.evidence, record.observedAt, ok
}
