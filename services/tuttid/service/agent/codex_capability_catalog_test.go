package agent

import (
	"encoding/json"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func TestParseCodexCapabilityResponses(t *testing.T) {
	skills := parseCodexSkillCapabilities(json.RawMessage(`{"data":[{"skills":[{"name":"review","description":"Review code","path":"/tmp/review/SKILL.md","enabled":true}]}]}`))
	if len(skills) != 1 || skills[0].Kind != "skill" || skills[0].Trigger != "$review" || skills[0].Path == "" {
		t.Fatalf("parseCodexSkillCapabilities = %#v", skills)
	}

	apps := parseCodexAppCapabilities(json.RawMessage(`{"data":[{"id":"github","name":"GitHub","description":"GitHub connector","isAccessible":true,"isEnabled":true}]}`))
	if len(apps) != 1 || apps[0].Kind != "connector" || apps[0].Path != "app://github" || apps[0].Invocation != "promptItem" {
		t.Fatalf("parseCodexAppCapabilities = %#v", apps)
	}

	mcp := parseCodexMCPCapabilities(json.RawMessage(`{"data":[{"name":"docs","status":"running","tools":[{"name":"search","description":"Search docs"}]}]}`))
	if len(mcp) != 2 || mcp[0].Kind != "mcpServer" || mcp[1].Kind != "mcpTool" || mcp[1].ToolName != "search" {
		t.Fatalf("parseCodexMCPCapabilities = %#v", mcp)
	}
}

func TestComposerCapabilityCatalogListerRejectsUnknownKind(t *testing.T) {
	_, ok, err := composerCapabilityCatalogLister(composerProfile{
		CapabilityCatalogKind:    "poison",
		CapabilityCatalogCommand: []string{"codex", "app-server"},
	})
	if err == nil || ok {
		t.Fatalf("composerCapabilityCatalogLister() = (_, %v, %v), want unsupported error", ok, err)
	}
}

func TestComposerCapabilityCatalogListerRequiresRuntimeCommand(t *testing.T) {
	_, ok, err := composerCapabilityCatalogLister(composerProfile{
		CapabilityCatalogKind: providerregistry.CapabilityCatalogKindCodexAppServer,
	})
	if err == nil || ok {
		t.Fatalf("composerCapabilityCatalogLister() = (_, %v, %v), want command error", ok, err)
	}
}
