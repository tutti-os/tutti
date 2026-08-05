package agent

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func TestParseCodexCapabilityResponses(t *testing.T) {
	skills := parseCodexSkillCapabilities(json.RawMessage(`{"data":[{"skills":[{"name":"review","description":"Review code","path":"/tmp/review/SKILL.md","enabled":true}]}]}`))
	if len(skills) != 1 ||
		skills[0].Kind != "skill" ||
		skills[0].Status != "available" ||
		skills[0].Trigger != "$review" ||
		skills[0].Path == "" ||
		skills[0].Invocation != "promptItem" {
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

func TestAppServerCapabilityListSkillsOnly(t *testing.T) {
	var stdin bytes.Buffer
	if err := writeAppServerCapabilityListRequests(
		&stdin,
		"/tmp/workspace",
		appServerCatalogRequestSetSkillsOnly,
	); err != nil {
		t.Fatalf("writeAppServerCapabilityListRequests returned error: %v", err)
	}
	requests := stdin.String()
	if !strings.Contains(requests, `"method":"skills/list"`) {
		t.Fatalf("requests = %q, want skills/list", requests)
	}
	for _, excluded := range []string{"app/list", "plugin/list", "mcpServerStatus/list"} {
		if strings.Contains(requests, excluded) {
			t.Fatalf("requests = %q, must not include %s", requests, excluded)
		}
	}

	options, err := readAppServerCapabilityListResponses(
		strings.NewReader(`{"id":"2","result":{"data":[{"skills":[{"name":"review","description":"Review","path":"/tmp/review/SKILL.md","enabled":true}]}]}}`+"\n"),
		appServerCatalogRequestSetSkillsOnly,
	)
	if err != nil {
		t.Fatalf("readAppServerCapabilityListResponses returned error: %v", err)
	}
	if len(options) != 1 {
		t.Fatalf("options = %#v, want one skill", options)
	}
	skill := options[0]
	if skill.ID != "skill:review" ||
		skill.Kind != "skill" ||
		skill.Trigger != "$review" ||
		skill.Path != "/tmp/review/SKILL.md" ||
		skill.Invocation != "promptItem" {
		t.Fatalf("skill option = %#v", skill)
	}
}

func TestAppServerCapabilityListCodexRetainsConnectorAndMCPDiscovery(t *testing.T) {
	var stdin bytes.Buffer
	if err := writeAppServerCapabilityListRequests(&stdin, "/tmp/workspace", appServerCatalogRequestSetCodex); err != nil {
		t.Fatalf("writeAppServerCapabilityListRequests returned error: %v", err)
	}
	requests := stdin.String()
	for _, included := range []string{"skills/list", "app/list", "mcpServerStatus/list"} {
		if !strings.Contains(requests, included) {
			t.Fatalf("requests = %q, want %s", requests, included)
		}
	}
	if strings.Contains(requests, "plugin/list") {
		t.Fatalf("requests = %q, plugin inventory must remain independent", requests)
	}

	options, err := readAppServerCapabilityListResponses(strings.NewReader(
		`{"id":"2","result":{"data":[{"skills":[{"name":"review","enabled":true}]}]}}`+"\n"+
			`{"id":"3","result":{"data":[{"id":"github","name":"GitHub"}]}}`+"\n"+
			`{"id":"5","result":{"data":[{"name":"docs","status":"running"}]}}`+"\n",
	), appServerCatalogRequestSetCodex)
	if err != nil {
		t.Fatalf("readAppServerCapabilityListResponses returned error: %v", err)
	}
	if len(options) != 3 || options[1].Kind != "connector" || options[2].Kind != "mcpServer" {
		t.Fatalf("options = %#v, want skill, connector, and MCP server", options)
	}
}

func TestAppServerCatalogRequestsRejectsUnknownSet(t *testing.T) {
	if _, _, err := appServerCatalogRequests("/tmp/workspace", "poison"); err == nil {
		t.Fatal("appServerCatalogRequests() error = nil, want unsupported request set")
	}
}
