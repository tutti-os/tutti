package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

func TestParseCodexPluginInventoryUsesOnlyKnownNativePluginIDs(t *testing.T) {
	records, errors := parseCodexPluginInventory(json.RawMessage(`{
		"marketplaces":[{
			"name":"openai-bundled",
			"path":"/parent-marketplace-path",
			"plugins":[
				{"id":"browser@openai-bundled","name":"browser","source":{"type":"local","path":"/plugin-root"},"installed":true,"enabled":true},
				{"id":"browser@third-party","name":"browser","source":{"type":"local","path":"/third-party"},"installed":true,"enabled":true}
			]
		}]
	}`))
	if len(errors) != 0 {
		t.Fatalf("errors = %#v", errors)
	}
	if len(records) != 3 {
		t.Fatalf("records = %#v, want three native semantic slots", records)
	}
	browser := records[0]
	if browser.option.Semantic != "browserUse" ||
		browser.pluginID != "browser@openai-bundled" ||
		browser.marketplacePath != "/parent-marketplace-path" ||
		browser.sourceRoot != "/plugin-root" {
		t.Fatalf("browser record = %#v", browser)
	}
	for _, record := range records {
		if record.pluginID == "browser@third-party" {
			t.Fatalf("third-party browser must not become a native semantic: %#v", records)
		}
	}
}

func TestParseCodexPluginInventoryReadsPluginInterfaceAndFailsOpenOnDuplicateSemantic(t *testing.T) {
	records, errors := parseCodexPluginInventory(json.RawMessage(`{
		"marketplaces":[
			{"name":"openai-bundled","path":"/one","plugins":[
				{"id":"browser@openai-bundled","name":"browser","source":{"type":"local","path":"/one/browser"},"interface":{"displayName":"Browser One","shortDescription":"One"}}
			]},
			{"name":"openai-bundled","path":"/two","plugins":[
				{"id":"browser@openai-bundled","name":"browser","source":{"type":"local","path":"/two/browser"},"interface":{"displayName":"Browser Two","shortDescription":"Two"}},
				{"id":"sites@openai-bundled","name":"sites","source":{"type":"local","path":"/two/sites"},"interface":{"displayName":"Sites label","shortDescription":"Sites description"}}
			]}
		]
	}`))
	if len(errors) != 0 {
		t.Fatalf("errors = %#v", errors)
	}
	for _, record := range records {
		switch record.option.Semantic {
		case "browserUse":
			if record.pluginID != "" || record.option.Status != ComposerPluginStatusUnknown {
				t.Fatalf("duplicate browser semantic must fail open: %#v", record)
			}
		case "sites":
			if record.option.Label != "Sites label" || record.option.Description != "Sites description" {
				t.Fatalf("plugin interface fields = %#v", record.option)
			}
		}
	}
}

func TestParseCodexPluginInventoryRejectsNativeMarketplaceLoadFailure(t *testing.T) {
	_, errors := parseCodexPluginInventory(json.RawMessage(`{
		"marketplaces":[],
		"marketplaceLoadErrors":[{"marketplace":"openai-bundled","message":"failed"}]
	}`))
	if len(errors) != 1 || !strings.Contains(errors[0], "native plugin marketplace") {
		t.Fatalf("errors = %#v, want native marketplace failure", errors)
	}

	_, errors = parseCodexPluginInventory(json.RawMessage(`{
		"marketplaces":[],
		"marketplaceLoadErrors":[{"marketplace":"third-party","message":"failed"}]
	}`))
	if len(errors) != 0 {
		t.Fatalf("unrelated marketplace errors must not poison native snapshot: %#v", errors)
	}
}

func TestVerifyCodexPluginReadMappingRequiresExactLocalThreeWayProof(t *testing.T) {
	root := t.TempDir()
	skillPath := filepath.Join(root, "skills", "sites", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(skillPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(skillPath, []byte("# skill"), 0o600); err != nil {
		t.Fatal(err)
	}
	record := codexPluginInventoryRecord{
		pluginID:        "sites@openai-bundled",
		pluginName:      "sites",
		marketplacePath: "/marketplaces/openai-bundled",
		sourceRoot:      root,
	}
	valid := codexPluginReadResponse(t, record, root, skillPath)
	skills, ok := verifyCodexPluginReadMapping(valid, record)
	canonicalSkillPath, canonical := canonicalLocalPluginPath(skillPath)
	if !canonical {
		t.Fatalf("canonicalLocalPluginPath(%q) failed", skillPath)
	}
	if !ok || len(skills) != 1 || skills[0].Name != "sites:sites-building" || skills[0].Path != canonicalSkillPath {
		t.Fatalf("valid mapping = %#v, ok=%v", skills, ok)
	}

	for name, raw := range map[string]json.RawMessage{
		"summary id mismatch": codexPluginReadResponse(t, codexPluginInventoryRecord{
			pluginID:        "other@openai-bundled",
			pluginName:      record.pluginName,
			marketplacePath: record.marketplacePath,
			sourceRoot:      root,
		}, root, skillPath),
		"marketplace mismatch": codexPluginReadResponse(t, codexPluginInventoryRecord{
			pluginID:        record.pluginID,
			pluginName:      record.pluginName,
			marketplacePath: "/other-marketplace",
			sourceRoot:      root,
		}, root, skillPath),
	} {
		t.Run(name, func(t *testing.T) {
			if got, ok := verifyCodexPluginReadMapping(raw, record); ok || len(got) != 0 {
				t.Fatalf("unproven mapping = %#v, ok=%v", got, ok)
			}
		})
	}

	escaped := filepath.Join(t.TempDir(), "outside", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(escaped), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(escaped, []byte("# outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, ok := verifyCodexPluginReadMapping(
		codexPluginReadResponse(t, record, root, escaped),
		record,
	); ok || len(got) != 0 {
		t.Fatalf("path outside plugin root = %#v, ok=%v", got, ok)
	}
}

func TestRequestCodexPluginInventoryUsesRemoteLocatorButDoesNotHideRemoteSkills(t *testing.T) {
	stdout := strings.NewReader("{\"id\":\"1\",\"result\":{}}\n" +
		"{\"id\":\"plugin-list\",\"result\":{\"marketplaces\":[{\"name\":\"remote-openai\",\"plugins\":[{\"id\":\"sites@openai-bundled\",\"name\":\"sites\",\"source\":{\"type\":\"remote\"},\"installed\":true,\"enabled\":true}]}]}}\n" +
		"{\"id\":\"plugin-read-2\",\"result\":{\"plugin\":{\"skills\":[{\"name\":\"sites:sites-building\"}]}}}\n")
	var stdin bytes.Buffer
	result := requestCodexPluginInventory(&stdin, stdout, "/workspace")
	if len(result.errors) != 0 || len(result.records) != 3 {
		t.Fatalf("result = %#v", result)
	}
	requests := stdin.String()
	if !strings.Contains(requests, "remoteMarketplaceName") || strings.Contains(requests, "marketplacePath") {
		t.Fatalf("remote plugin/read locator = %s", requests)
	}
	for _, record := range result.records {
		if record.option.Semantic == "sites" && len(record.option.BundledSkills) != 0 {
			t.Fatalf("remote skills cannot satisfy local proof: %#v", record)
		}
	}
}

func TestRequestCodexPluginInventorySendsReadsTogetherAndKeepsIndependentProofs(t *testing.T) {
	root := t.TempDir()
	browserPath := filepath.Join(root, "browser", "SKILL.md")
	sitesPath := filepath.Join(root, "sites", "SKILL.md")
	for _, path := range []string{browserPath, sitesPath} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("# skill"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	sites := codexPluginInventoryRecord{pluginID: "sites@openai-bundled", pluginName: "sites", marketplacePath: "/marketplace", sourceRoot: root}
	stdout := strings.NewReader(
		`{"id":"1","result":{}}` + "\n" +
			`{"id":"plugin-list","result":{"marketplaces":[{"name":"openai-bundled","path":"/marketplace","plugins":[` +
			`{"id":"browser@openai-bundled","name":"browser","source":{"type":"local","path":"` + root + `"},"installed":true,"enabled":true},` +
			`{"id":"sites@openai-bundled","name":"sites","source":{"type":"local","path":"` + root + `"},"installed":true,"enabled":true}` +
			`]}]}}` + "\n" +
			`{"id":"plugin-read-2","result":` + string(codexPluginReadResponse(t, sites, root, sitesPath)) + `}` + "\n" +
			`{"id":"plugin-read-0","error":{"message":"unavailable"}}` + "\n",
	)
	var stdin bytes.Buffer
	result := requestCodexPluginInventory(&stdin, stdout, "/workspace")
	if len(result.errors) != 0 {
		t.Fatalf("result errors = %#v", result.errors)
	}
	requests := stdin.String()
	if !strings.Contains(requests, `"id":"plugin-read-0"`) || !strings.Contains(requests, `"id":"plugin-read-2"`) {
		t.Fatalf("expected both read requests before response handling: %s", requests)
	}
	for _, record := range result.records {
		if record.option.Semantic == "sites" && len(record.option.BundledSkills) != 1 {
			t.Fatalf("sites mapping must survive browser read failure: %#v", record)
		}
	}
}

func TestCodexPluginInventoryResponseStreamEOFIsStableAfterUnknownErrorResponse(t *testing.T) {
	stream := newCodexPluginInventoryResponseStream(
		context.Background(),
		strings.NewReader(`{"id":"unknown","error":{"message":"ignored"}}`+"\n"),
	)
	response, err := stream.next(context.Background())
	if err != nil || codexRPCIDString(response["id"]) != "unknown" {
		t.Fatalf("first response = %#v, %v", response, err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_, err := stream.next(ctx)
		cancel()
		if !errors.Is(err, io.EOF) {
			t.Fatalf("EOF attempt %d = %v, want io.EOF", attempt, err)
		}
	}
}

func TestCodexPluginInventoryCacheKeepsLastVerifiedSnapshotAfterFailure(t *testing.T) {
	cache := newCodexPluginInventoryCache()
	scope := codexPluginInventoryScope{
		agentTargetID: "local:codex",
		provider:      "codex",
		cwd:           "/workspace",
		command:       "codex",
		args:          []string{"app-server"},
	}
	done := make(chan struct{})
	cache.primeWithLister(scope, time.Second, func(context.Context, string) codexPluginInventoryResult {
		defer close(done)
		return codexPluginInventoryResult{records: []codexPluginInventoryRecord{{
			option: ComposerPluginOption{ID: "plugin:browser@openai-bundled", Name: "browser", Label: "Browser", Semantic: "browserUse", Status: ComposerPluginStatusReady},
		}}}
	})
	<-done
	awaitCodexPluginInventorySnapshot(t, cache, scope.cacheKey(), false)

	cache.mu.Lock()
	entry := cache.entries[scope.cacheKey()]
	entry.freshUntil = time.Now().UTC().Add(-time.Second)
	cache.entries[scope.cacheKey()] = entry
	cache.mu.Unlock()
	failed := make(chan struct{})
	cache.primeWithLister(scope, time.Second, func(context.Context, string) codexPluginInventoryResult {
		defer close(failed)
		return codexPluginInventoryResult{errors: []string{"plugin/list failed"}}
	})
	<-failed
	records, partial, _ := cache.snapshot(scope.cacheKey())
	if partial || len(records) != 1 || records[0].option.Semantic != "browserUse" {
		t.Fatalf("stale success must survive a refresh failure: records=%#v partial=%v", records, partial)
	}
}

func TestCodexPluginInventoryCacheRequestsRefreshForMissingAndStaleSnapshots(t *testing.T) {
	cache := newCodexPluginInventoryCache()
	key := "missing"
	if _, partial, refresh := cache.snapshot(key); !partial || !refresh {
		t.Fatalf("missing snapshot = partial:%v refresh:%v, want true:true", partial, refresh)
	}
	cache.entries[key] = codexPluginInventoryCacheEntry{
		lastSuccess: []codexPluginInventoryRecord{{option: ComposerPluginOption{Semantic: "sites"}}},
		freshUntil:  time.Now().UTC().Add(-time.Second),
		staleUntil:  time.Now().UTC().Add(time.Minute),
	}
	if _, partial, refresh := cache.snapshot(key); partial || !refresh {
		t.Fatalf("stale snapshot = partial:%v refresh:%v, want false:true", partial, refresh)
	}
}

func TestCodexPluginInventoryCachePrunesExpiredEntriesAndCapsNewScopes(t *testing.T) {
	cache := newCodexPluginInventoryCache()
	expiredKey := "expired"
	cache.entries[expiredKey] = codexPluginInventoryCacheEntry{
		lastSuccess: []codexPluginInventoryRecord{{option: ComposerPluginOption{Semantic: "sites"}}},
		staleUntil:  time.Now().UTC().Add(-time.Second),
	}
	if _, _, refresh := cache.snapshot(expiredKey); !refresh {
		t.Fatal("expired snapshot must request refresh")
	}
	if _, exists := cache.entries[expiredKey]; exists {
		t.Fatalf("expired entry %q was retained", expiredKey)
	}

	now := time.Now().UTC()
	for index := 0; index < codexPluginInventoryMaxEntries; index++ {
		key := fmt.Sprintf("scope-%03d", index)
		cache.entries[key] = codexPluginInventoryCacheEntry{staleUntil: now.Add(time.Duration(index) * time.Second)}
	}
	cache.mu.Lock()
	cache.evictOldestEntryLocked()
	cache.mu.Unlock()
	if len(cache.entries) != codexPluginInventoryMaxEntries-1 {
		t.Fatalf("entries after cap eviction = %d, want %d", len(cache.entries), codexPluginInventoryMaxEntries-1)
	}
	if _, exists := cache.entries["scope-000"]; exists {
		t.Fatal("oldest non-flight entry was not evicted")
	}
}

func TestCodexPluginInventoryCacheCapsConcurrentNewScopes(t *testing.T) {
	cache := newCodexPluginInventoryCache()
	release := make(chan struct{})
	for index := 0; index < codexPluginInventoryMaxEntries+5; index++ {
		scope := codexPluginInventoryScope{agentTargetID: fmt.Sprintf("target-%d", index), provider: "codex", command: "codex"}
		cache.primeWithLister(scope, time.Second, func(context.Context, string) codexPluginInventoryResult {
			<-release
			return codexPluginInventoryResult{records: unknownCodexPluginInventoryRecords()}
		})
	}
	close(release)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		cache.mu.Lock()
		flights := len(cache.flights)
		entries := len(cache.entries)
		cache.mu.Unlock()
		if flights == 0 {
			if entries > codexPluginInventoryMaxEntries {
				t.Fatalf("entries = %d, cap = %d", entries, codexPluginInventoryMaxEntries)
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("concurrent refreshes did not settle")
}

func TestCodexPluginInventoryProcessTimeoutIsCappedAtEightSeconds(t *testing.T) {
	for name, timeout := range map[string]time.Duration{
		"default":     0,
		"outer prime": codexPluginInventoryPrimeTimeout,
		"larger":      30 * time.Second,
	} {
		t.Run(name, func(t *testing.T) {
			if got := (codexAppServerPluginInventoryLister{timeout: timeout}).processTimeout(); got != codexPluginInventoryTimeout {
				t.Fatalf("processTimeout() = %s, want %s", got, codexPluginInventoryTimeout)
			}
		})
	}
}

func TestCodexPluginInventoryRefreshLogsRedactedDiagnosticKinds(t *testing.T) {
	var output bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	logCodexPluginInventoryRefresh(codexPluginInventoryScope{provider: "codex", agentTargetID: "local:codex"}, codexPluginInventoryResult{
		errors:      []string{"plugin/list failed: token=secret"},
		diagnostics: []string{"codex app-server stderr: token=secret", "one or more plugin/read responses were missing"},
	})
	logs := output.String()
	for _, expected := range []string{"codex plugin inventory refresh failed", "plugin_list_failed", "app_server_stderr", "plugin_read_missing"} {
		if !strings.Contains(logs, expected) {
			t.Fatalf("logs missing %q: %s", expected, logs)
		}
	}
	if strings.Contains(logs, "secret") {
		t.Fatalf("logs must not include raw App Server diagnostics: %s", logs)
	}
}

func TestComposerPluginInventoryRejectsNonCodexAndProviderTargetMismatchBeforeRefresh(t *testing.T) {
	targets := make(map[string]agenttargetbiz.Target)
	for _, target := range agenttargetbiz.DefaultSystemTargets(1) {
		targets[target.ID] = target
	}
	service := &Service{
		AgentTargetStore:     fakeAgentTargetLookup{targets: targets},
		pluginInventoryCache: newCodexPluginInventoryCache(),
	}
	for name, input := range map[string]ComposerPluginOptionsInput{
		"non codex target":  {Provider: "claude-code", AgentTargetID: agenttargetbiz.IDLocalClaudeCode},
		"provider mismatch": {Provider: "claude-code", AgentTargetID: agenttargetbiz.IDLocalCodex},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := service.GetComposerPluginOptions(context.Background(), input); !errors.Is(err, ErrInvalidArgument) {
				t.Fatalf("GetComposerPluginOptions(%#v) error = %v, want invalid argument", input, err)
			}
			if len(service.pluginInventoryCache.flights) != 0 {
				t.Fatal("unsupported scope started plugin inventory refresh")
			}
		})
	}
}

func codexPluginReadResponse(
	t *testing.T,
	record codexPluginInventoryRecord,
	root string,
	skillPath string,
) json.RawMessage {
	t.Helper()
	payload := map[string]any{
		"plugin": map[string]any{
			"marketplacePath": record.marketplacePath,
			"summary": map[string]any{
				"id":     record.pluginID,
				"name":   record.pluginName,
				"source": map[string]any{"type": "local", "path": root},
			},
			"skills": []map[string]any{{
				"enabled": true,
				"name":    "sites:sites-building",
				"path":    skillPath,
			}},
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func awaitCodexPluginInventorySnapshot(
	t *testing.T,
	cache *codexPluginInventoryCache,
	key string,
	wantPartial bool,
) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		records, partial, _ := cache.snapshot(key)
		if len(records) == 1 && partial == wantPartial {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("snapshot did not settle")
}
