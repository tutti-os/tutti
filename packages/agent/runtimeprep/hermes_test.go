package runtimeprep

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestHermesPreparerMaterializesSkillsToPerSessionHermesHome 守住 hermes
// extension 的 skill 加载根因修复。hermes-agent 只从 $HERMES_HOME/skills/
// 和 $HERMES_HOME/config.yaml 的 skills.external_dirs 发现 skill，根本不读
// extension 声明的 .agent_context/skills；且 config.yaml（model/provider 接线）
// 与 auth.json（凭证）都锚定 HERMES_HOME。因此 HermesPreparer 必须为每个
// session 注入独立 HERMES_HOME，把全局 config.yaml/auth.json 复制进去（否则
// 复现 "No LLM provider configured"），并把 tutti skill 物化到
// $HERMES_HOME/skills/（hermes 原生发现路径）。AGENTS.md 仍写到 cwd。
func TestHermesPreparerMaterializesSkillsToPerSessionHermesHome(t *testing.T) {
	// 模拟用户全局 hermes home（含 config + auth + .env），用 HERMES_HOME 指向它做隔离。
	globalHome := t.TempDir()
	t.Setenv("HERMES_HOME", globalHome)
	globalFiles := map[string][]byte{
		"config.yaml": []byte("model: test-model\nproviders: {}\n"),
		"auth.json":   []byte(`{"version":1,"providers":{}}`),
		".env":        []byte("OPENCODE_ZEN_API_KEY=test-key\n"),
	}
	for name, content := range globalFiles {
		if err := os.WriteFile(filepath.Join(globalHome, name), content, 0o600); err != nil {
			t.Fatalf("write global %s: %v", name, err)
		}
	}

	stateDir := t.TempDir()
	cwd := t.TempDir()
	prepared, err := NewDefaultPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "local:hermes",
		Provider:       "acp:hermes",
		Cwd:            cwd,
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}

	hermesHome := ""
	for _, env := range prepared.Env {
		if strings.HasPrefix(env, "HERMES_HOME=") {
			hermesHome = strings.TrimPrefix(env, "HERMES_HOME=")
		}
	}
	if hermesHome == "" {
		t.Fatalf("HERMES_HOME not set in prepared env; hermes cannot isolated-skill-load without it. env=%v", prepared.Env)
	}

	// config.yaml + auth.json + .env 必须从全局 home 复制进 per-session HERMES_HOME：
	// config.yaml 带 model/provider 接线，auth.json 带凭证，.env 带 provider API key。
	for name, want := range globalFiles {
		got, err := os.ReadFile(filepath.Join(hermesHome, name))
		if err != nil {
			t.Fatalf("%s not copied into per-session HERMES_HOME: %v", name, err)
		}
		if string(got) != string(want) {
			t.Fatalf("%s copy mismatch: want %q, got %q", name, want, got)
		}
	}

	// tutti skill 物化到 $HERMES_HOME/skills/（hermes 原生发现路径），而非
	// .agent_context/skills（hermes 不读）。fresh per-session 目录无碰撞后缀。
	for _, name := range []string{tuttiHandoffSkillName, tuttiSkillName} {
		skillPath := filepath.Join(hermesHome, "skills", name, "SKILL.md")
		if _, err := os.Stat(skillPath); err != nil {
			t.Fatalf("skill %s SKILL.md missing in HERMES_HOME/skills: %v", name, err)
		}
	}

	// AGENTS.md 仍写到 cwd（hermes 读 cwd/AGENTS.md 作为 mention routing 上下文）。
	if _, err := os.Stat(filepath.Join(cwd, "AGENTS.md")); err != nil {
		t.Fatalf("cwd AGENTS.md missing: %v", err)
	}
}

// TestHermesPreparerDoesNotMaterializeToAgentContextSkills 确认 hermes 的 skill
// 不再物化到 .agent_context/skills（hermes 不读该目录），避免无谓写入与重复目录。
func TestHermesPreparerDoesNotMaterializeToAgentContextSkills(t *testing.T) {
	t.Setenv("HERMES_HOME", t.TempDir())
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
		t.Fatalf(".agent_context/skills should not exist for hermes (hermes does not read it), got err=%v", err)
	}
}
