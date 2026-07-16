package agentsessionstore

// WorkspaceAgentCapabilityReference is immutable submission provenance. It is
// deliberately not a source of truth for Tutti-owned activation state.
type WorkspaceAgentCapabilityReference struct {
	Capability string `json:"capability"`
	Source     string `json:"source"`
}
