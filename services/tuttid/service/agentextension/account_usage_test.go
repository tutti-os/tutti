package agentextension

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	agentextensiondata "github.com/tutti-os/tutti/services/tuttid/data/agentextension"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func TestAccountUsageServiceUsesExplicitLocalCompanionForLocalExtension(t *testing.T) {
	manifest := testManifest()
	manifest.Profiles.AccountUsage = "profiles/account-usage.json"
	sourceDir := t.TempDir()
	if err := extractPackage(
		testPackageZIPFor(t, manifest, `{"schemaVersion":"tutti.agent.discovery.v1","candidates":[{"binaryNames":["gemini"],"version":{"args":["--version"],"constraint":">=0.50.0 <1.0.0"},"launchArgs":["--acp"],"probe":{"kind":"acp-initialize","timeoutMs":5000}}]}`),
		sourceDir,
	); err != nil {
		t.Fatal(err)
	}
	helperExecutable := filepath.Join(testResolvedTempDir(t), "account-usage")
	if err := os.WriteFile(helperExecutable, []byte("#!/usr/bin/env node\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	store := &targetStoreStub{targets: map[string]agenttargetbiz.Target{}}
	manager := &Manager{
		Sources: []tuttitypes.AgentExtensionSource{{
			Key: "gemini", LocalPackageDir: sourceDir,
			LocalAccountUsageExecutable: helperExecutable,
		}},
		Installations:     agentextensiondata.NewFileInstallationStore(t.TempDir()),
		RuntimeInstallDir: filepath.Join(testResolvedTempDir(t), "agent-runtimes"),
		Store:             store,
	}
	installation, err := manager.installLocalPackage("gemini", sourceDir)
	if err != nil {
		t.Fatal(err)
	}
	if !installation.HasLocalPackageProvenance() {
		t.Fatalf("local installation version = %q", installation.Version)
	}
	if got := manager.localAccountUsageExecutable(installation); got != helperExecutable {
		t.Fatalf("local account usage executable = %q", got)
	}
	profile, err := loadAccountUsageProfile(installation)
	if err != nil {
		t.Fatal(err)
	}
	nodePath, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is unavailable")
	}
	nodePath, err = filepath.EvalSymlinks(nodePath)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("TUTTI_APP_NODE", nodePath)
	if _, err := manager.resolvedLocalAccountUsageRuntimeBinding(helperExecutable, profile); err != nil {
		t.Fatalf("local account usage binding: %v", err)
	}
	launchRef, err := agenttargetbiz.CanonicalLaunchRefJSON(
		installation.Provider,
		agenttargetbiz.LaunchRef{
			Type:                    agenttargetbiz.LaunchRefTypeAgentExtension,
			ExtensionInstallationID: installation.ID,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	const targetID = "extension:gemini"
	store.targets[targetID] = agenttargetbiz.Target{
		ID: targetID, Provider: installation.Provider, LaunchRefJSON: launchRef,
		Name: "Gemini CLI", Enabled: true, Source: agenttargetbiz.SourceSystem,
	}
	var node string
	var script string
	var args []string
	service := AccountUsageService{
		Manager: manager,
		Targets: store,
		run: func(_ context.Context, gotNode string, gotScript string, gotArgs []string, nodeIdentity *agentruntime.ExecutableIdentity, scriptIdentity *agentruntime.ExecutableIdentity, _ int) ([]byte, error) {
			node = gotNode
			script = gotScript
			args = append([]string(nil), gotArgs...)
			if nodeIdentity == nil || scriptIdentity == nil {
				t.Fatal("local account usage identities = nil")
			}
			return []byte(`{"schemaVersion":"tutti.agent.account-usage.v1","outcome":"available","capturedAtUnixMs":1,"billingMode":"api","quotas":[]}`), nil
		},
	}
	result, err := service.Probe(context.Background(), targetID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != "available" || result.BillingMode != "api" || len(result.Quotas) != 0 {
		t.Fatalf("local API billing result = %#v", result)
	}
	if node != nodePath || script != helperExecutable || !reflect.DeepEqual(args, []string{"--output", "json"}) {
		t.Fatalf("local account usage command = %q %q %#v", node, script, args)
	}
}

func TestAccountUsageServiceTreatsOlderExtensionAsUnsupported(t *testing.T) {
	store := &targetStoreStub{targets: map[string]agenttargetbiz.Target{}}
	manager := &Manager{
		Installations:     agentextensiondata.NewFileInstallationStore(t.TempDir()),
		RuntimeInstallDir: filepath.Join(testResolvedTempDir(t), "agent-runtimes"),
		Store:             store,
	}
	installation, err := installTestPackage(
		t,
		manager,
		Release{AgentKey: "gemini", Version: "1.0.0"},
		testPackageZIP(t),
	)
	if err != nil {
		t.Fatal(err)
	}
	launchRef, err := agenttargetbiz.CanonicalLaunchRefJSON(
		installation.Provider,
		agenttargetbiz.LaunchRef{
			Type:                    agenttargetbiz.LaunchRefTypeAgentExtension,
			ExtensionInstallationID: installation.ID,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	const targetID = "extension:gemini"
	store.targets[targetID] = agenttargetbiz.Target{
		ID: targetID, Provider: installation.Provider, LaunchRefJSON: launchRef,
		Name: "Gemini CLI", Enabled: true, Source: agenttargetbiz.SourceSystem,
	}
	result, err := (AccountUsageService{Manager: manager, Targets: store}).Probe(
		context.Background(),
		targetID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != "unsupported" || result.AgentTargetID != targetID || result.Provider != installation.Provider {
		t.Fatalf("old extension account usage = %#v", result)
	}
}

func TestDecodeAccountUsagePayloadAcceptsProviderOwnedGoldenResult(t *testing.T) {
	t.Parallel()
	payload, err := os.ReadFile("testdata/kimi-account-usage-available.json")
	if err != nil {
		t.Fatal(err)
	}
	result, err := decodeAccountUsagePayload(payload)
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != "available" || result.BillingMode != "subscription" || result.CapturedAtUnixMS != 1_770_000_000_000 || len(result.Quotas) != 2 {
		t.Fatalf("account usage result = %#v", result)
	}
	if result.Quotas[0].QuotaType != "weekly" || result.Quotas[0].PercentRemaining != 72 {
		t.Fatalf("weekly quota = %#v", result.Quotas[0])
	}
	if result.Quotas[1].ModelName != "K2 model" || result.Quotas[1].PercentRemaining != 25 {
		t.Fatalf("model quota = %#v", result.Quotas[1])
	}
}

func TestDecodeAccountUsagePayloadFailsClosed(t *testing.T) {
	t.Parallel()
	tests := map[string]string{
		"unknown schema":        `{"schemaVersion":"tutti.agent.account-usage.v2","outcome":"unsupported","capturedAtUnixMs":1}`,
		"unknown outcome":       `{"schemaVersion":"tutti.agent.account-usage.v1","outcome":"future","capturedAtUnixMs":1}`,
		"unknown success field": `{"schemaVersion":"tutti.agent.account-usage.v1","outcome":"available","capturedAtUnixMs":1,"billingMode":"subscription","quotas":[{"quotaType":"weekly","percentRemaining":50}],"raw":"secret"}`,
		"empty subscription":    `{"schemaVersion":"tutti.agent.account-usage.v1","outcome":"available","capturedAtUnixMs":1,"billingMode":"subscription","quotas":[]}`,
		"null API quotas":       `{"schemaVersion":"tutti.agent.account-usage.v1","outcome":"available","capturedAtUnixMs":1,"billingMode":"api","quotas":null}`,
		"API quotas":            `{"schemaVersion":"tutti.agent.account-usage.v1","outcome":"available","capturedAtUnixMs":1,"billingMode":"api","quotas":[{"quotaType":"weekly","percentRemaining":50}]}`,
		"unknown quota":         `{"schemaVersion":"tutti.agent.account-usage.v1","outcome":"available","capturedAtUnixMs":1,"billingMode":"subscription","quotas":[{"quotaType":"future","percentRemaining":50}]}`,
		"invalid percent":       `{"schemaVersion":"tutti.agent.account-usage.v1","outcome":"available","capturedAtUnixMs":1,"billingMode":"subscription","quotas":[{"quotaType":"weekly","percentRemaining":101}]}`,
		"free text error":       `{"schemaVersion":"tutti.agent.account-usage.v1","outcome":"error","capturedAtUnixMs":1,"errorCode":"execution_failed","message":"secret path"}`,
		"unknown error code":    `{"schemaVersion":"tutti.agent.account-usage.v1","outcome":"error","capturedAtUnixMs":1,"errorCode":"provider_message"}`,
		"trailing JSON":         `{"schemaVersion":"tutti.agent.account-usage.v1","outcome":"unsupported","capturedAtUnixMs":1}{}`,
	}
	for name, payload := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeAccountUsagePayload([]byte(payload)); err == nil {
				t.Fatal("decodeAccountUsagePayload() error = nil")
			}
		})
	}
}

func TestDecodeAccountUsagePayloadAllowsExplicitAPIBilling(t *testing.T) {
	t.Parallel()
	result, err := decodeAccountUsagePayload([]byte(`{"schemaVersion":"tutti.agent.account-usage.v1","outcome":"available","capturedAtUnixMs":1,"billingMode":"api","quotas":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if result.BillingMode != "api" || len(result.Quotas) != 0 {
		t.Fatalf("API billing result = %#v", result)
	}
}
