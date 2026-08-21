package agenthost

type RuntimeSessionScope string

const (
	RuntimeSessionScopeCanonical RuntimeSessionScope = "canonical"
	RuntimeSessionScopeSide      RuntimeSessionScope = "side"
)

type SideConversationCapabilities struct {
	Supported bool
	// ActiveSourceTurn means the provider can snapshot a source with an active
	// Turn; it does not require the source to remain active after Side opens.
	ActiveSourceTurn      bool
	Ephemeral             bool
	HideInheritedTurns    bool
	ModelBoundaryInjected bool
}

type OpenSideConversationInput struct {
	WorkspaceID          string
	SourceAgentSessionID string
	SideAgentSessionID   string
	RequestID            string
}

type RuntimeOpenSideConversationInput struct {
	Source             ProviderRuntimeSession
	SideAgentSessionID string
	RequestID          string
}

type OpenSideConversationResult struct {
	Session      ProviderRuntimeSession
	Capabilities SideConversationCapabilities
}
