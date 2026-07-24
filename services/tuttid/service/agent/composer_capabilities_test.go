package agent

import (
	"context"
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
				{Scope: "user", Path: ".agents/skills"},
			},
		},
	}}
	ref := map[string]any{
		"kind":                    "agent_extension",
		"extensionInstallationId": "hermes@1.0.0",
	}
	roots := service.resolveExtensionSkillRoots(context.Background(), ref)
	if want := []string{".agent_context/skills"}; !reflect.DeepEqual(roots, want) {
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
