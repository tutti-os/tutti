package agent

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func TestMergeCodexComposerCapabilityOptionsDeduplicatesSkillFileAliases(t *testing.T) {
	directory := t.TempDir()
	nativePath := filepath.Join(directory, "SKILL.md")
	fallbackPath := filepath.Join(directory, "SKILL-alias.md")
	if err := os.WriteFile(nativePath, []byte("---\nname: example\n---\n"), 0o600); err != nil {
		t.Fatalf("write native skill: %v", err)
	}
	if err := os.Link(nativePath, fallbackPath); err != nil {
		t.Fatalf("create skill file alias: %v", err)
	}

	options := mergeCodexComposerCapabilityOptions(
		[]ComposerCapabilityOption{{
			ID:   "skill:example",
			Kind: "skill",
			Name: "example",
			Path: fallbackPath,
		}},
		[]ComposerCapabilityOption{{
			ID:   "skill:plugin:example",
			Kind: "skill",
			Name: "plugin:example",
			Path: nativePath,
		}},
	)

	if len(options) != 1 {
		t.Fatalf("options = %#v, want one canonical skill", options)
	}
	if options[0].ID != "skill:plugin:example" || options[0].Name != "plugin:example" || options[0].Path != nativePath {
		t.Fatalf("option = %#v, want native namespaced skill", options[0])
	}
}

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

func TestAppServerCatalogRequestsRejectsUnknownSet(t *testing.T) {
	if _, _, err := appServerCatalogRequests("/tmp/workspace", "poison"); err == nil {
		t.Fatal("appServerCatalogRequests() error = nil, want unsupported request set")
	}
}
