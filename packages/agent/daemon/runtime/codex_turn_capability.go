package agentruntime

import (
	"context"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

type CodexTurnCapabilityInput struct {
	RoomID         string
	AgentSessionID string
	TurnID         string
	ClientSubmitID string
	Semantic       string
}

// EnsureCodexTurnCapability proves that a capability will be attached to the
// current live Codex runtime. It neither starts/resumes a thread nor performs
// plugin discovery; the resulting mention is consumed by the normal turn/start
// request owned by Host.
func (c *Controller) EnsureCodexTurnCapability(ctx context.Context, input CodexTurnCapabilityInput) (PromptContentBlock, error) {
	roomID := strings.TrimSpace(input.RoomID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if roomID == "" || agentSessionID == "" || strings.TrimSpace(input.TurnID) == "" || strings.TrimSpace(input.ClientSubmitID) == "" {
		return PromptContentBlock{}, ErrSessionNotFound
	}
	release, err := c.acquireLifecycleLockContext(ctx, roomID, agentSessionID)
	if err != nil {
		return PromptContentBlock{}, err
	}
	defer release()
	session, adapter, err := c.sessionAndAdapter(roomID, agentSessionID)
	if err != nil || !providerregistry.SupportsNativePluginTurn(session.Provider) {
		return PromptContentBlock{}, ErrSessionNotFound
	}
	codex, ok := adapter.(*CodexAppServerAdapter)
	if !ok || codex == nil {
		return PromptContentBlock{}, ErrSessionNotFound
	}
	return codex.ensureLiveTurnCapability(session, input.Semantic)
}

func (a *CodexAppServerAdapter) ensureLiveTurnCapability(session Session, semantic string) (PromptContentBlock, error) {
	semantic = strings.TrimSpace(semantic)
	a.mu.Lock()
	live := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	ready := live != nil && live.client != nil && strings.TrimSpace(live.threadID) == strings.TrimSpace(session.ProviderSessionID)
	a.mu.Unlock()
	if !ready {
		return PromptContentBlock{}, ErrSessionNotFound
	}
	pluginID, ok := codexNativeTurnPluginID(semantic)
	if !ok {
		return PromptContentBlock{}, ErrSessionNotFound
	}
	return PromptContentBlock{Type: "mention", Name: pluginID, Path: "plugin://" + pluginID}, nil
}

func codexNativeTurnPluginID(semantic string) (string, bool) {
	switch strings.TrimSpace(semantic) {
	case "browser":
		return "browser@openai-bundled", true
	case "computer":
		return "computer-use@openai-bundled", true
	case "sites":
		return "sites@openai-bundled", true
	default:
		return "", false
	}
}
