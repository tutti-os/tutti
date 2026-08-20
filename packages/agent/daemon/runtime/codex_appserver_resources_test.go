package agentruntime

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestCountCodexAppServerPluginsCountsInstalledEnabledUniquePlugins(t *testing.T) {
	count, ok := countCodexAppServerPlugins(json.RawMessage(`{
		"marketplaces": [
			{"name":"local","plugins":[
				{"id":"one","name":"one","installed":true,"enabled":true},
				{"id":"one","name":"one","installed":true,"enabled":true},
				{"id":"two","name":"two","installed":true,"enabled":false},
				{"id":"three","name":"three","installed":false,"enabled":true}
			]}
		]
	}`))
	if !ok || count != 1 {
		t.Fatalf("plugin count = %d, parsed = %t, want 1/true", count, ok)
	}
}

func TestCountCodexAppServerSkillsCountsEnabledUniqueSkills(t *testing.T) {
	count, ok := countCodexAppServerSkills(json.RawMessage(`{
		"data": [
			{"skills":[
				{"name":"one","path":"/one/SKILL.md","enabled":true},
				{"name":"one","path":"/one/SKILL.md","enabled":true},
				{"name":"two","path":"/two/SKILL.md","enabled":false},
				{"name":"three","path":"/three/SKILL.md"}
			]}
		]
	}`))
	if !ok || count != 2 {
		t.Fatalf("skill count = %d, parsed = %t, want 2/true", count, ok)
	}
}

func TestCountCodexAppServerResourcesRejectsMalformedResponses(t *testing.T) {
	if count, ok := countCodexAppServerPlugins(json.RawMessage(`not-json`)); ok || count != 0 {
		t.Fatalf("plugin malformed response = %d/%t, want 0/false", count, ok)
	}
	if count, ok := countCodexAppServerSkills(json.RawMessage(`{"data":`)); ok || count != 0 {
		t.Fatalf("skill malformed response = %d/%t, want 0/false", count, ok)
	}
}

func TestCodexAppServerStartCollectsResourceSnapshotWithoutBlockingStartup(t *testing.T) {
	transport := newScriptedAppServerTransport()
	observations := make(chan CodexAppServerResourceObservation, 1)
	adapter := NewCodexAppServerAdapterWithHostMetadataAndOptions(
		transport,
		LegacyHostMetadata(),
		CodexAppServerAdapterOptions{
			StartupResourceObserver: func(observation CodexAppServerResourceObservation) {
				observations <- observation
			},
		},
	)
	session := testAppServerSession()
	session.MCPServers = []MCPServerBinding{{Name: "mcp-one"}, {Name: "mcp-two"}}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	select {
	case observation := <-observations:
		t.Fatalf("Start waited for resource probe: %#v", observation)
	default:
	}

	select {
	case observation := <-observations:
		if observation.Outcome != "succeeded" || observation.MCPServerCount != 2 || observation.PluginCount != 1 || observation.SkillCount != 1 {
			t.Fatalf("resource observation = %#v, want successful 2/1/1 snapshot", observation)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for resource snapshot")
	}
}
