package agentruntime

// OpenClaw's ACP provider config (`openclaw acp -v`). OpenClaw's
// session/set_mode maps to a gateway thinkingLevel rather than a permission
// channel, so the config declares no permission-mode mapping.

import (
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func NewOpenClawAdapter(transport ProcessTransport) *standardACPAdapter {
	return NewOpenClawAdapterWithHostMetadata(transport, LegacyHostMetadata())
}

func NewOpenClawAdapterWithHostMetadata(transport ProcessTransport, host HostMetadata) *standardACPAdapter {
	descriptor, ok := providerregistry.Find(ProviderOpenClaw)
	if !ok {
		panic("openclaw provider descriptor is missing")
	}
	return newOpenClawAdapterFromProviderDescriptor(descriptor, transport, host, nil)
}

func newOpenClawAdapterFromProviderDescriptor(descriptor providerregistry.ProviderDescriptor, transport ProcessTransport, host HostMetadata, commandResolver ProviderCommandResolver) *standardACPAdapter {
	adapter := newStandardACPAdapterFromProviderDescriptor(descriptor, transport, host, commandResolver)
	adapter.config.env = func(session Session) []string { return openclawACPEnv(session, host) }
	adapter.config.applySessionMeta = func(params map[string]any, session Session, host HostMetadata) {
		mergeACPParamsMeta(params, map[string]any{"sessionKey": openclawGatewayChatSessionKey(session, host)})
	}
	return adapter
}

// openclawGatewayChatSessionKey selects the gateway sessionKey hint for OpenClaw GUI ACP.
// Without it, openclaw acp falls back to "acp:<uuid>", which makes the gateway treat the chat as an
// ACP-spawned session and require sessions.json metadata that this desktop flow never writes.
func openclawGatewayChatSessionKey(session Session, host HostMetadata) string {
	prefix := host.OpenClawSessionKeyPrefix
	if strings.TrimSpace(session.AgentSessionID) != "" {
		return fmt.Sprintf("%s%s", prefix, session.AgentSessionID)
	}
	return prefix + "desktop"
}

func openclawACPEnv(session Session, host HostMetadata) []string {
	env := standardACPEnv(session, host)
	// OpenClaw enables Node's module compile cache before its ACP runtime starts.
	// With routed ACP startup this can stall before JSON-RPC initialize responds.
	env = append(env, "NODE_DISABLE_COMPILE_CACHE=1")
	return env
}
