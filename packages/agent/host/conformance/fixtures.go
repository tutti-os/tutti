package conformance

func liveSessionFixture(sessionID, activeTurnID string) Fixture {
	return Fixture{Session: &SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: sessionID, Provider: "codex",
		ProviderSessionID: "provider-" + sessionID, Cwd: "/workspace", Title: "Session title",
		ActiveTurnID: activeTurnID, InitialTitleEstablished: true, Live: true,
	}}
}
