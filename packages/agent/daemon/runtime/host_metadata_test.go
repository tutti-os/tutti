package agentruntime

import "testing"

func TestHostMetadataDefaultsMatchLegacyBehavior(t *testing.T) {
	t.Parallel()

	host := normalizeHostMetadata(HostMetadata{})
	if host.ClientInfo.Name != "tsh-desktop" || host.ClientInfo.Title != "tsh" || host.ClientInfo.Version != "0.1.0" {
		t.Fatalf("client info = %#v, want legacy tsh desktop metadata", host.ClientInfo)
	}
	if got := workspaceEnv(Session{RoomID: "workspace-1"}, host); len(got) != 1 || got[0] != "TUTTI_WORKSPACE_ID=workspace-1" {
		t.Fatalf("workspace env = %#v, want TUTTI_WORKSPACE_ID", got)
	}
	if got := openclawGatewayChatSessionKey(Session{AgentSessionID: "session-1"}, host); got != "agent:main:tsh-session-1" {
		t.Fatalf("session key = %q, want legacy tsh key", got)
	}
	if got := openclawGatewayChatSessionKey(Session{}, host); got != "agent:main:tsh-desktop" {
		t.Fatalf("fallback session key = %q, want legacy desktop key", got)
	}
}

func TestHostMetadataCustomizesACPParamsAndEnv(t *testing.T) {
	t.Parallel()

	host := HostMetadata{
		ClientInfo: ClientInfo{
			Name:    "business-desktop",
			Title:   "Business",
			Version: "2.3.4",
		},
		WorkspaceEnvName:         "BUSINESS_WORKSPACE_ID",
		OpenClawSessionKeyPrefix: "agent:main:business-",
	}
	params := defaultACPInitializeParams(host)
	clientInfo, ok := params["clientInfo"].(map[string]any)
	if !ok {
		t.Fatalf("clientInfo = %#v, want map", params["clientInfo"])
	}
	if clientInfo["name"] != "business-desktop" || clientInfo["title"] != "Business" || clientInfo["version"] != "2.3.4" {
		t.Fatalf("clientInfo = %#v, want custom metadata", clientInfo)
	}
	if got := standardACPEnv(Session{RoomID: "workspace-1"}, host); len(got) != 6 || got[5] != "BUSINESS_WORKSPACE_ID=workspace-1" {
		t.Fatalf("standard env = %#v, want custom workspace env", got)
	}
	if got := openclawGatewayChatSessionKey(Session{AgentSessionID: "session-1"}, host); got != "agent:main:business-session-1" {
		t.Fatalf("session key = %q, want custom prefix", got)
	}
}

func TestHostMetadataHelpersDoNotApplyLegacyDefaults(t *testing.T) {
	t.Parallel()

	host := HostMetadata{}
	params := defaultACPInitializeParams(host)
	clientInfo, ok := params["clientInfo"].(map[string]any)
	if !ok {
		t.Fatalf("clientInfo = %#v, want map", params["clientInfo"])
	}
	if clientInfo["name"] == "tsh-desktop" || clientInfo["title"] == "tsh" || clientInfo["version"] == "0.1.0" {
		t.Fatalf("clientInfo = %#v, want no legacy defaults", clientInfo)
	}
	if got := standardACPEnv(Session{RoomID: "workspace-1"}, host); len(got) != 5 {
		t.Fatalf("standard env = %#v, want no legacy workspace env", got)
	}
	if got := openclawGatewayChatSessionKey(Session{AgentSessionID: "session-1"}, host); got == "agent:main:tsh-session-1" {
		t.Fatalf("session key = %q, want no legacy tsh key", got)
	}
}
