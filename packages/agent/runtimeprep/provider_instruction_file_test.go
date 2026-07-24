package runtimeprep

import (
	"os"
	"path/filepath"
	"strings"
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
	prepared, err := NewDefaultPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:         "workspace-1",
		AgentSessionID:      "session-1",
		AgentTargetID:       "local:hermes",
		Provider:            "acp:hermes",
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
	if _, err := NewDefaultPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "local:hermes",
		Provider:       "acp:hermes",
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

// TestProviderSpecificExecutionEnvironmentIncludesACPExtension 确认 acp: 前缀的
// extension provider 在 AGENTS.md 里也拿到 localhost/IPC 执行环境提示，和
// built-in CLI provider 一致，而非走 default 返回空。
func TestProviderSpecificExecutionEnvironmentIncludesACPExtension(t *testing.T) {
	got := providerSpecificExecutionEnvironment("acp:hermes", "tutti")
	if !strings.Contains(got, "localhost/IPC") {
		t.Fatalf("acp:hermes execution env = %q, want localhost/IPC hint", got)
	}
}
