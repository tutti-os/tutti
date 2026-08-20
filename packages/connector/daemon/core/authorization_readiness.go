package host

import (
	"strings"
	"sync"
)

// AuthorizationReadinessGate records whether account-scoped server truth has
// been hydrated for this daemon lifetime. It carries no permission; it only
// prevents stale disk projections from publishing remote routes after startup
// or an account switch.
type AuthorizationReadinessGate struct {
	mu    sync.RWMutex
	ready map[string]bool
}

func NewAuthorizationReadinessGate() *AuthorizationReadinessGate {
	return &AuthorizationReadinessGate{ready: make(map[string]bool)}
}

func (gate *AuthorizationReadinessGate) Ready(accountID string) bool {
	if gate == nil || strings.TrimSpace(accountID) == "" {
		return false
	}
	gate.mu.RLock()
	defer gate.mu.RUnlock()
	return gate.ready[strings.TrimSpace(accountID)]
}

// SetReady returns true when the state changed.
func (gate *AuthorizationReadinessGate) SetReady(accountID string, ready bool) bool {
	if gate == nil || strings.TrimSpace(accountID) == "" {
		return false
	}
	accountID = strings.TrimSpace(accountID)
	gate.mu.Lock()
	defer gate.mu.Unlock()
	previous := gate.ready[accountID]
	gate.ready[accountID] = ready
	return previous != ready
}
