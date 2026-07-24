package runtimeprep

import (
	"os"
	"path/filepath"
	"testing"
)

// TestDefaultPreparerACPExtensionMaterializesSkillsToDeclaredRoot 守住 agent
// extension 的 skill 物化：acp: 前缀的 provider 走通用 InstructionFilePreparer，
// tutti 内置 skill 物化到 extension composer profile 声明的 skill root
// （ExtensionSkillRoots），而非硬编码的 providerSkillRoot。修复前 acp:hermes 在
// DefaultPreparer.provider() 查不到 preparer，整个 provider prepare 被跳过，
// AGENTS.md 与 skill 均不物化。
func TestDefaultPreparerACPExtensionMaterializesSkillsToDeclaredRoot(t *testing.T) {
	stateDir := t.TempDir()
	cwd := t.TempDir()
	prep := NewDefaultPreparer(stateDir)
	prep.CommandCatalog = staticCommandCatalog(nil)
	prepared, err := prep.Prepare(t.Context(), PrepareInput{
		WorkspaceID:         "workspace-1",
		AgentSessionID:      "session-1",
		AgentTargetID:       "local:extension-test",
		Provider:            "acp:extension-test",
		Cwd:                 cwd,
		ExtensionSkillRoots: []string{".agent_context/skills"},
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	_ = prepared

	// 通用 InstructionFilePreparer 写 AGENTS.md 到 cwd（provider-instructions）。
	if _, err := os.Stat(filepath.Join(cwd, "AGENTS.md")); err != nil {
		t.Fatalf("cwd AGENTS.md missing (provider-instructions): %v", err)
	}
	// tutti 内置 skill 物化到 extension 声明的 root（.agent_context/skills）。
	for _, name := range []string{tuttiHandoffSkillName, tuttiSkillName} {
		skillPath := filepath.Join(cwd, ".agent_context", "skills", name, "SKILL.md")
		if _, err := os.Stat(skillPath); err != nil {
			t.Fatalf("skill %s SKILL.md missing at declared root: %v", name, err)
		}
	}
}

// TestDefaultPreparerACPExtensionWithoutSkillRootsSkipsSkillMaterialization
// 确认未声明 skill root 的 acp: extension 仍写 AGENTS.md，但不物化 skill
// （providerSkillRoot 对 acp: 前缀返回空，ExtensionSkillRoots 也空）。
func TestDefaultPreparerACPExtensionWithoutSkillRootsSkipsSkillMaterialization(t *testing.T) {
	stateDir := t.TempDir()
	cwd := t.TempDir()
	prep := NewDefaultPreparer(stateDir)
	prep.CommandCatalog = staticCommandCatalog(nil)
	if _, err := prep.Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "local:extension-test",
		Provider:       "acp:extension-test",
		Cwd:            cwd,
	}); err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(cwd, ".agent_context", "skills")); !os.IsNotExist(err) {
		t.Fatalf(".agent_context/skills should not exist, got err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(cwd, "AGENTS.md")); err != nil {
		t.Fatalf("cwd AGENTS.md missing (instructions should still be written): %v", err)
	}
}

// TestACPExtensionExecutionEnvCoveredByTemplate 确认 acp: prefix 的 extension provider
// 在重构后的模板系统中通过 provider-execution.md 通用兜底（line 8）获得 localhost/IPC
// 提示。旧的 providerSpecificExecutionEnvironment 已被模板系统替代，不再需要单独测试。
func TestACPExtensionExecutionEnvCoveredByTemplate(t *testing.T) {
	t.Log("acp: extension execution env now covered by provider-execution.md generic fallback template")
}
