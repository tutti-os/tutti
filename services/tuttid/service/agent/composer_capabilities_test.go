package agent

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"
)

// TestServiceResolveExtensionSkillRootsPicksWorkspaceScope 确认 service 只取
// extension composer profile 里 workspace scope 的 skill root 路径填入
// PrepareInput.ExtensionSkillRoots，user scope 不物化（per-session prepare 不该
// 每次重写用户级目录）。
func TestServiceResolveExtensionSkillRootsPicksWorkspaceScope(t *testing.T) {
	service := newTestService(newFakeRuntime())
	service.ExtensionComposerProfiles = extensionComposerProfileResolverStub{profile: ExtensionComposerProfile{
		Skills: &ExtensionComposerSkillProfile{
			Invocation:    "textTrigger",
			TriggerPrefix: "/",
			Roots: []ExtensionComposerSkillRoot{
				{Scope: "workspace", Path: ".agent_context/skills"},
				{Scope: "workspace", Path: ".agent_context/../.agent_context/other-skills"},
				{Scope: "workspace", Path: "../outside"},
				{Scope: "workspace", Path: "."},
				{Scope: "workspace", Path: filepath.Join(t.TempDir(), "skills")},
				{Scope: "user", Path: ".agents/skills"},
			},
		},
	}}
	ref := map[string]any{
		"kind":                    "agent_extension",
		"extensionInstallationId": "hermes@1.0.0",
	}
	roots := service.resolveExtensionSkillRoots(context.Background(), ref)
	if want := []string{".agent_context/skills", ".agent_context/other-skills"}; !reflect.DeepEqual(roots, want) {
		t.Fatalf("resolveExtensionSkillRoots() = %#v, want %#v (workspace scope only)", roots, want)
	}
}

// TestServiceResolveExtensionSkillRootsEmptyWhenNoSkills 确认非 extension
// provider 或 profile 无 skills 时返回空，不物化 skill。
func TestServiceResolveExtensionSkillRootsEmptyWhenNoSkills(t *testing.T) {
	service := newTestService(newFakeRuntime())
	service.ExtensionComposerProfiles = extensionComposerProfileResolverStub{profile: ExtensionComposerProfile{}}
	if roots := service.resolveExtensionSkillRoots(context.Background(), map[string]any{"kind": "builtin"}); len(roots) != 0 {
		t.Fatalf("non-extension roots = %#v, want empty", roots)
	}
	ref := map[string]any{"kind": "agent_extension", "extensionInstallationId": "hermes@1.0.0"}
	if roots := service.resolveExtensionSkillRoots(context.Background(), ref); len(roots) != 0 {
		t.Fatalf("no-skills roots = %#v, want empty", roots)
	}
}

func TestServiceClampExtensionBrowserUseRequiresDeclaredCapability(t *testing.T) {
	t.Setenv("TUTTI_BROWSER_USE", "1")
	truePtr := true
	ref := map[string]any{"kind": "agent_extension", "extensionInstallationId": "hermes@1.0.0"}
	service := newTestService(newFakeRuntime())
	service.ExtensionComposerProfiles = extensionComposerProfileResolverStub{profile: ExtensionComposerProfile{
		Capabilities: []string{"compact"},
	}}
	if service.clampComposerBrowserUseForLaunch(context.Background(), "acp:hermes", ref, &truePtr) {
		t.Fatal("extension without browserUse declaration should clamp browserUse off")
	}
	service.ExtensionComposerProfiles = extensionComposerProfileResolverStub{profile: ExtensionComposerProfile{
		Capabilities: []string{"browserUse"},
	}}
	if !service.clampComposerBrowserUseForLaunch(context.Background(), "acp:hermes", ref, nil) {
		t.Fatal("extension with browserUse declaration should default browserUse on")
	}
	t.Setenv("TUTTI_BROWSER_USE", "0")
	if service.clampComposerBrowserUseForLaunch(context.Background(), "acp:hermes", ref, &truePtr) {
		t.Fatal("operator browserUse master switch should clamp extension browserUse off")
	}
}

func TestServiceClampExtensionComputerUseRequiresDeclaredCapability(t *testing.T) {
	t.Setenv("TUTTI_COMPUTER_USE", "1")
	truePtr := true
	ref := map[string]any{"kind": "agent_extension", "extensionInstallationId": "hermes@1.0.0"}
	service := newTestService(newFakeRuntime())
	service.ComputerUseAvailable = func() bool { return true }
	service.ExtensionComposerProfiles = extensionComposerProfileResolverStub{profile: ExtensionComposerProfile{
		Capabilities: []string{"browserUse"},
	}}
	if service.clampComposerComputerUseForLaunch(context.Background(), "acp:hermes", ref, &truePtr) {
		t.Fatal("extension without computerUse declaration should clamp computerUse off")
	}
	service.ExtensionComposerProfiles = extensionComposerProfileResolverStub{profile: ExtensionComposerProfile{
		Capabilities: []string{"computerUse"},
	}}
	if !service.clampComposerComputerUseForLaunch(context.Background(), "acp:hermes", ref, nil) {
		t.Fatal("extension with computerUse declaration should default computerUse on")
	}
	service.ComputerUseAvailable = func() bool { return false }
	if service.clampComposerComputerUseForLaunch(context.Background(), "acp:hermes", ref, &truePtr) {
		t.Fatal("unavailable computerUse runtime should clamp extension computerUse off")
	}
}
