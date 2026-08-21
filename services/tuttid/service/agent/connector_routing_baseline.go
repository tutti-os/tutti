package agent

import (
	"strings"
	"sync"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
)

// connectorRoutingBaselines tracks, per prepared session, the connector alias
// index that was materialized into the session's provider instructions. A
// missing entry means the session was prepared without Connector enhancement,
// so no turn-level routing update may be injected for it. Entries live in
// memory only: after a daemon restart every session is re-prepared on resume,
// which re-materializes a current index before the next turn is admitted.
type connectorRoutingBaselines struct {
	entries sync.Map // key -> rendered alias index (string)
}

func connectorRoutingBaselineKey(workspaceID, agentSessionID string) string {
	return strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(agentSessionID)
}

func (b *connectorRoutingBaselines) record(workspaceID, agentSessionID, index string) {
	b.entries.Store(connectorRoutingBaselineKey(workspaceID, agentSessionID), index)
}

func (b *connectorRoutingBaselines) clear(workspaceID, agentSessionID string) {
	b.entries.Delete(connectorRoutingBaselineKey(workspaceID, agentSessionID))
}

func (b *connectorRoutingBaselines) load(workspaceID, agentSessionID string) (string, bool) {
	value, ok := b.entries.Load(connectorRoutingBaselineKey(workspaceID, agentSessionID))
	if !ok {
		return "", false
	}
	index, ok := value.(string)
	return index, ok
}

// commit advances the baseline only while the session is still tracked, so a
// concurrent cleanup cannot be resurrected by a late turn admission.
func (b *connectorRoutingBaselines) commit(workspaceID, agentSessionID, index string) {
	key := connectorRoutingBaselineKey(workspaceID, agentSessionID)
	if _, ok := b.entries.Load(key); ok {
		b.entries.Store(key, index)
	}
}

// pendingConnectorRoutingUpdate reports the current connector alias index when
// it diverged from the index rendered into this session's instructions at
// preparation time. The comparison uses the rendered index rather than a raw
// registry revision so changes that cannot affect the prompt (for example
// beyond the index rune budget) never trigger an update.
func (s *Service) pendingConnectorRoutingUpdate(workspaceID, agentSessionID string) (string, bool) {
	if s == nil || s.ConnectorRuntime == nil {
		return "", false
	}
	baseline, tracked := s.connectorRoutingBaselines.load(workspaceID, agentSessionID)
	if !tracked {
		return "", false
	}
	current := runtimeprep.ConnectorRoutingIndex(s.ConnectorRuntime.RoutingHints())
	if current == baseline {
		return "", false
	}
	return current, true
}
