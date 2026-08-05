package agentruntime

import "testing"

func TestCodexNativeTurnPluginID(t *testing.T) {
	t.Parallel()
	for semantic, want := range map[string]string{
		"browser":  "browser@openai-bundled",
		"computer": "computer-use@openai-bundled",
		"sites":    "sites@openai-bundled",
	} {
		got, ok := codexNativeTurnPluginID(semantic)
		if !ok || got != want {
			t.Fatalf("plugin id for %q = %q, %v; want %q, true", semantic, got, ok, want)
		}
	}
}

func TestCodexNativeTurnPluginIDRejectsUnknownSemantic(t *testing.T) {
	t.Parallel()
	if _, ok := codexNativeTurnPluginID("not-a-plugin"); ok {
		t.Fatal("unknown semantic was accepted")
	}
}

func TestCodexAppServerAdapterEnsureLiveTurnCapability(t *testing.T) {
	t.Parallel()
	adapter := &CodexAppServerAdapter{sessions: map[string]*codexAppServerSession{
		"session-1": {client: &codexAppServerClient{}, threadID: "thread-1"},
	}}
	session := Session{AgentSessionID: "session-1", ProviderSessionID: "thread-1"}
	mention, err := adapter.ensureLiveTurnCapability(session, "browser")
	if err != nil {
		t.Fatalf("ensure browser capability: %v", err)
	}
	if mention.Path != "plugin://browser@openai-bundled" {
		t.Fatalf("mention = %#v", mention)
	}
	if mention, err := adapter.ensureLiveTurnCapability(session, "computer"); err != nil || mention.Path != "plugin://computer-use@openai-bundled" {
		t.Fatalf("computer capability = %#v, error = %v", mention, err)
	}
	if _, err := adapter.ensureLiveTurnCapability(Session{AgentSessionID: "session-1", ProviderSessionID: "other-thread"}, "sites"); err == nil {
		t.Fatalf("stale runtime error = %v, want session not found", err)
	}
}
