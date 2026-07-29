package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
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

func TestParseCodexPluginCapabilitiesUsesMarketplaceShape(t *testing.T) {
	plugins, errs := parseCodexPluginCapabilities(json.RawMessage(`{
		"marketplaces":[{
			"name":"openai-bundled",
			"plugins":[
				{
					"id":"browser@openai-bundled",
					"name":"browser",
					"enabled":true,
					"installed":true,
					"availability":"AVAILABLE",
					"interface":{
						"displayName":"Browser",
						"shortDescription":"Control the in-app browser"
					},
					"source":{"type":"local","path":"/tmp/browser"}
				},
				{
					"id":"sites@openai-bundled",
					"name":"sites",
					"enabled":true,
					"installed":true,
					"interface":{"displayName":"Sites","shortDescription":"Build and deploy websites"}
				},
				{
					"id":"computer-use@openai-bundled",
					"name":"computer-use",
					"enabled":false,
					"installed":true,
					"interface":{"displayName":"Computer Use"}
				},
				{
					"id":"visualize@openai-bundled",
					"name":"visualize",
					"enabled":true,
					"installed":false,
					"interface":{"displayName":"Visualize"}
				},
				{
					"id":"blocked@openai-bundled",
					"name":"blocked",
					"enabled":true,
					"installed":true,
					"installPolicy":"NOT_AVAILABLE",
					"interface":{"displayName":"Blocked"}
				},
				{
					"id":"remote-uninstalled@remote-marketplace",
					"name":"remote-uninstalled",
					"enabled":false,
					"installed":false,
					"interface":{"displayName":"Remote Uninstalled"}
				}
			]
		}],
		"marketplaceLoadErrors":[{"marketplacePath":"/tmp/broken","message":"missing marketplace.json"}]
	}`))
	if len(errs) != 1 || !strings.Contains(errs[0], "missing marketplace.json") {
		t.Fatalf("plugin errors = %#v", errs)
	}
	if len(plugins) != 5 {
		t.Fatalf("plugin count = %d, want 5 after omitting irrelevant remote entries: %#v", len(plugins), plugins)
	}

	byID := map[string]ComposerCapabilityOption{}
	for _, plugin := range plugins {
		byID[plugin.ID] = plugin
	}

	browser := byID["plugin:browser@openai-bundled"]
	if browser.Kind != "plugin" ||
		browser.Name != "browser" ||
		browser.Label != "Browser" ||
		browser.Description != "Control the in-app browser" ||
		browser.Status != "available" ||
		browser.PluginName != "browser" ||
		browser.Path != "plugin://browser@openai-bundled" ||
		browser.Trigger != "$browser" ||
		browser.Invocation != "promptItem" ||
		browser.Source != "local" {
		t.Fatalf("browser plugin = %#v", browser)
	}

	sites := byID["plugin:sites@openai-bundled"]
	if sites.Path != "plugin://sites@openai-bundled" || sites.Status != "available" || sites.Invocation != "promptItem" {
		t.Fatalf("sites plugin = %#v", sites)
	}

	computer := byID["plugin:computer-use@openai-bundled"]
	if computer.Status != "disabled" || computer.Invocation != "none" || computer.Path != "plugin://computer-use@openai-bundled" {
		t.Fatalf("computer-use plugin = %#v", computer)
	}

	visualize := byID["plugin:visualize@openai-bundled"]
	if visualize.Status != "setupRequired" || visualize.Invocation != "none" {
		t.Fatalf("visualize plugin = %#v", visualize)
	}

	blocked := byID["plugin:blocked@openai-bundled"]
	if blocked.Status != "setupRequired" || blocked.Invocation != "none" {
		t.Fatalf("blocked plugin = %#v", blocked)
	}
	if _, ok := byID["plugin:remote-uninstalled@remote-marketplace"]; ok {
		t.Fatalf("explicitly uninstalled and disabled remote plugin must not reach the composer: %#v", byID)
	}
}

func TestCodexNativeComposerPluginOptionsOnlyProjectsNativePluginsInStableOrder(t *testing.T) {
	options := []ComposerCapabilityOption{
		{ID: "plugin:visualize@openai-bundled", Kind: "plugin", Name: "visualize"},
		{ID: "plugin:" + runtimeprep.CodexNativePluginBrowser, Kind: "plugin", Name: "browser", Semantic: "browserUse"},
		{ID: "skill:imagegen", Kind: "skill", Name: "imagegen"},
		{ID: "plugin:" + runtimeprep.CodexNativePluginComputerUse, Kind: "plugin", Name: "computer-use", Status: "setupRequired", Semantic: "computerUse"},
		{ID: "plugin:" + runtimeprep.CodexNativePluginSites, Kind: "plugin", Name: "sites", Semantic: "sites"},
	}

	projected := codexNativeComposerPluginOptions(options)
	if got, want := len(projected), 3; got != want {
		t.Fatalf("native plugin count = %d, want %d: %#v", got, want, projected)
	}
	if got := []string{projected[0].Semantic, projected[1].Semantic, projected[2].Semantic}; !reflect.DeepEqual(got, []string{"sites", "browserUse", "computerUse"}) {
		t.Fatalf("native plugin order = %#v", got)
	}
	if projected[2].Status != "setupRequired" {
		t.Fatalf("computer status = %#v, want setupRequired", projected[2])
	}
}

func TestCodexNativeComputerPluginStaysVisibleBeforeInstallation(t *testing.T) {
	plugins, errs := parseCodexPluginCapabilities(json.RawMessage(`{
		"marketplaces":[{
			"name":"openai-bundled",
			"plugins":[{
				"id":"computer-use@openai-bundled",
				"name":"computer-use",
				"installed":false,
				"enabled":false,
				"interface":{"displayName":"Computer Use"}
			}]
		}]
	}`))
	if len(errs) != 0 || len(plugins) != 1 {
		t.Fatalf("plugins = %#v, errors = %#v", plugins, errs)
	}
	if plugins[0].Status != "setupRequired" || plugins[0].Semantic != "computerUse" {
		t.Fatalf("computer plugin = %#v", plugins[0])
	}
}

func TestParseCodexPluginCapabilitiesRejectsLegacyDataShape(t *testing.T) {
	plugins, errs := parseCodexPluginCapabilities(json.RawMessage(`{"data":[{"name":"browser","id":"browser@openai-bundled"}]}`))
	if len(plugins) != 0 {
		t.Fatalf("legacy data shape should parse as empty marketplaces, got %#v", plugins)
	}
	if len(errs) != 0 {
		t.Fatalf("empty marketplaces should not be treated as invalid shape, errs=%#v", errs)
	}
}

func TestParseCodexPluginCapabilitiesInvalidJSON(t *testing.T) {
	plugins, errs := parseCodexPluginCapabilities(json.RawMessage(`{"marketplaces":`))
	if len(plugins) != 0 || len(errs) != 1 || !strings.Contains(errs[0], "invalid") {
		t.Fatalf("invalid json = plugins %#v errs %#v", plugins, errs)
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

func TestRequestCodexCapabilityListCompletesInitializeHandshake(t *testing.T) {
	transport := &strictCodexCapabilityHandshakeTransport{}

	result, err := requestCodexCapabilityList(transport, transport, "/tmp/workspace")
	if err != nil {
		t.Fatalf("requestCodexCapabilityList returned error: %v", err)
	}
	wantMethods := []string{"initialize", "initialized", "skills/list", "app/list", "plugin/list", "mcpServerStatus/list"}
	if !reflect.DeepEqual(transport.methods, wantMethods) {
		t.Fatalf("request methods = %#v, want %#v", transport.methods, wantMethods)
	}
	if !reflect.DeepEqual(transport.pluginListParams, map[string]any{"cwds": []any{"/tmp/workspace"}}) {
		t.Fatalf("plugin/list params = %#v", transport.pluginListParams)
	}
	if _, ok := transport.pluginListParams["limit"]; ok {
		t.Fatalf("plugin/list must not send unsupported limit: %#v", transport.pluginListParams)
	}

	byID := map[string]ComposerCapabilityOption{}
	for _, option := range result.Options {
		byID[option.ID] = option
	}
	browser := byID["plugin:browser@openai-bundled"]
	if browser.Path != "plugin://browser@openai-bundled" || browser.Status != "available" {
		t.Fatalf("browser option = %#v", browser)
	}
	if len(result.Errors) != 0 {
		t.Fatalf("errors = %#v, want empty", result.Errors)
	}
}

func TestRequestCodexCapabilityListSurfacesPluginRPCErrors(t *testing.T) {
	transport := &strictCodexCapabilityHandshakeTransport{failPluginList: true}

	result, err := requestCodexCapabilityList(transport, transport, "/tmp/workspace")
	if err != nil {
		t.Fatalf("requestCodexCapabilityList returned error: %v", err)
	}
	if len(result.Errors) != 1 || !strings.Contains(result.Errors[0], "plugin/list failed") {
		t.Fatalf("errors = %#v", result.Errors)
	}
	foundSkill := false
	for _, option := range result.Options {
		if option.ID == "skill:review" {
			foundSkill = true
		}
		if option.Kind == "plugin" {
			t.Fatalf("plugin options should be absent after plugin/list failure: %#v", option)
		}
	}
	if !foundSkill {
		t.Fatalf("skills should still be returned after plugin/list failure: %#v", result.Options)
	}
}

func TestCodexCLICapabilityListerDiscoversPluginsThroughFakeAppServer(t *testing.T) {
	scriptPath := filepath.Join(t.TempDir(), "codex")
	script := `#!/bin/sh
initialized=false
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      echo '{"id":"1","result":{"serverInfo":{"name":"codex"}}}'
      ;;
    *'"method":"initialized"'*)
      initialized=true
      ;;
    *skills/list*)
      if [ "$initialized" != true ]; then
        echo '{"id":"2","error":{"code":-32600,"message":"Not initialized"}}'
        exit 0
      fi
      echo '{"id":"2","result":{"data":[{"skills":[{"name":"review","description":"Review","path":"/tmp/review/SKILL.md","enabled":true}]}]}}'
      ;;
    *'"method":"app/list"'*)
      echo '{"id":"3","result":{"data":[]}}'
      ;;
    *plugin/list*)
      echo '{"id":"4","result":{"marketplaces":[{"name":"openai-bundled","plugins":[{"id":"browser@openai-bundled","name":"browser","enabled":true,"installed":true,"interface":{"displayName":"Browser","shortDescription":"In-app browser"},"source":{"type":"local"}}]}],"marketplaceLoadErrors":[]}}'
      ;;
    *mcpServerStatus/list*)
      echo '{"id":"5","result":{"data":[]}}'
      sleep 10
      exit 0
      ;;
  esac
done
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake codex script: %v", err)
	}

	result, err := (CodexCLICapabilityLister{
		Command: scriptPath,
		Timeout: 15 * time.Second,
	}).List(context.Background(), "/tmp/workspace")
	if err != nil {
		t.Fatalf("List returned error: %v", err)
	}
	foundBrowser := false
	for _, option := range result.Options {
		if option.ID == "plugin:browser@openai-bundled" {
			foundBrowser = true
			if option.Path != "plugin://browser@openai-bundled" || option.Invocation != "promptItem" {
				t.Fatalf("browser option = %#v", option)
			}
		}
	}
	if !foundBrowser {
		t.Fatalf("options = %#v, want browser plugin", result.Options)
	}
}

type strictCodexCapabilityHandshakeTransport struct {
	methods                []string
	initializeRequested    bool
	initializeResponseRead bool
	initializedReceived    bool
	pluginListParams       map[string]any
	failPluginList         bool
	responseStage          int
	pending                bytes.Buffer
}

func (t *strictCodexCapabilityHandshakeTransport) Write(p []byte) (int, error) {
	var request struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params map[string]any  `json:"params"`
	}
	if err := json.Unmarshal(p, &request); err != nil {
		return 0, err
	}
	t.methods = append(t.methods, request.Method)
	switch request.Method {
	case "initialize":
		t.initializeRequested = true
	case "initialized":
		if !t.initializeResponseRead {
			return 0, errors.New("initialized sent before initialize response was read")
		}
		if len(request.ID) != 0 {
			return 0, errors.New("initialized must be a notification without an id")
		}
		t.initializedReceived = true
	case "skills/list", "app/list", "plugin/list", "mcpServerStatus/list":
		if !t.initializedReceived {
			return 0, errors.New(request.Method + " sent before initialized")
		}
		if request.Method == "plugin/list" {
			t.pluginListParams = request.Params
		}
	default:
		return 0, errors.New("unexpected method " + request.Method)
	}
	return len(p), nil
}

func (t *strictCodexCapabilityHandshakeTransport) Read(p []byte) (int, error) {
	if t.pending.Len() > 0 {
		return t.pending.Read(p)
	}
	switch t.responseStage {
	case 0:
		if !t.initializeRequested {
			return 0, errors.New("initialize response requested before initialize write")
		}
		t.initializeResponseRead = true
		t.responseStage = 1
		_, _ = io.WriteString(&t.pending, `{"id":"1","result":{"serverInfo":{"name":"codex"}}}`+"\n")
		return t.pending.Read(p)
	case 1:
		if !t.initializedReceived {
			return 0, errors.New("capability responses requested before initialized")
		}
		t.responseStage = 2
		responses := []string{
			`{"id":"2","result":{"data":[{"skills":[{"name":"review","description":"Review","path":"/tmp/review/SKILL.md","enabled":true}]}]}}`,
			`{"id":"3","result":{"data":[]}}`,
		}
		if t.failPluginList {
			responses = append(responses, `{"id":"4","error":{"code":-32601,"message":"Method not found"}}`)
		} else {
			responses = append(responses, `{"id":"4","result":{"marketplaces":[{"name":"openai-bundled","plugins":[{"id":"browser@openai-bundled","name":"browser","enabled":true,"installed":true,"interface":{"displayName":"Browser"},"source":{"type":"local"}}]}],"marketplaceLoadErrors":[]}}`)
		}
		responses = append(responses, `{"id":"5","result":{"data":[]}}`)
		_, _ = io.WriteString(&t.pending, strings.Join(responses, "\n")+"\n")
		return t.pending.Read(p)
	default:
		return 0, io.EOF
	}
}

func TestReadCodexCapabilityListResponsesKeepsScanner(t *testing.T) {
	scanner := bufio.NewScanner(strings.NewReader(strings.Join([]string{
		`{"id":"2","result":{"data":[]}}`,
		`{"id":"3","result":{"data":[]}}`,
		`{"id":"4","result":{"marketplaces":[{"name":"openai-bundled","plugins":[{"id":"sites@openai-bundled","name":"sites","enabled":true,"installed":true,"interface":{"displayName":"Sites"}}]}]}}`,
		`{"id":"5","result":{"data":[]}}`,
	}, "\n") + "\n"))
	result, err := readCodexCapabilityListResponses(scanner)
	if err != nil {
		t.Fatalf("readCodexCapabilityListResponses error = %v", err)
	}
	if len(result.Options) != 1 || result.Options[0].ID != "plugin:sites@openai-bundled" {
		t.Fatalf("options = %#v", result.Options)
	}
}
