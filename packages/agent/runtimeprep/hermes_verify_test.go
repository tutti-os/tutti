package runtimeprep

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestHermesPreparerRealHermesDiscoversTuttiSkills 是本地集成验证（默认跳过，
// TUTTI_HERMES_VERIFY=1 才跑）：用真实 HermesPreparer + 真实全局 ~/.hermes 产出
// per-session HERMES_HOME，再 exec 系统 hermes 读 skills 列表，确认 hermes 真的能
// 发现 tutti-handoff/tutti-cli。非 CI 测试，依赖本机已装 hermes-agent。
func TestHermesPreparerRealHermesDiscoversTuttiSkills(t *testing.T) {
	if os.Getenv("TUTTI_HERMES_VERIFY") != "1" {
		t.Skip("set TUTTI_HERMES_VERIFY=1 to run real-hermes integration check")
	}
	if _, err := exec.LookPath("hermes"); err != nil {
		t.Skip("hermes not on PATH")
	}

	stateDir := t.TempDir()
	cwd := t.TempDir()
	result, err := NewDefaultPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID: "verify-ws", AgentSessionID: "verify-sess",
		AgentTargetID: "local:hermes", Provider: "acp:hermes", Cwd: cwd,
	})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	hermesHome := ""
	for _, e := range result.Env {
		if strings.HasPrefix(e, "HERMES_HOME=") {
			hermesHome = strings.TrimPrefix(e, "HERMES_HOME=")
		}
	}
	t.Logf("per-session HERMES_HOME=%s", hermesHome)
	t.Logf("skills dir listing:")
	entries, _ := os.ReadDir(filepath.Join(hermesHome, "skills"))
	for _, e := range entries {
		t.Logf("  - %s", e.Name())
	}

	cmd := exec.Command("hermes", "skills", "list")
	cmd.Env = append(os.Environ(), "HERMES_HOME="+hermesHome)
	out, err := cmd.CombinedOutput()
	t.Logf("hermes skills list output:\n%s", out)
	if err != nil {
		t.Fatalf("hermes skills list failed: %v", err)
	}
	listed := string(out)
	for _, name := range []string{tuttiHandoffSkillName, tuttiSkillName} {
		if !strings.Contains(listed, name) {
			t.Errorf("hermes did not discover tutti skill %q in skills list", name)
		}
	}

	// hermes doctor 会初始化 provider（创建 OpenAI client），能抓到缺 API key /
	// 缺 config 这类 session/new 才暴露的错误（skills list 抓不到，因为它不加载
	// provider）。确认 per-session home 的 config+auth+.env 让 provider 正常加载。
	doctor := exec.Command("hermes", "doctor")
	doctor.Env = append(os.Environ(), "HERMES_HOME="+hermesHome)
	doctorOut, doctorErr := doctor.CombinedOutput()
	t.Logf("hermes doctor output:\n%s", doctorOut)
	if doctorErr != nil {
		t.Fatalf("hermes doctor failed: %v", err)
	}
	for _, marker := range []string{"no API key", "No LLM provider", "OPENCODE_ZEN_API_KEY"} {
		if strings.Contains(string(doctorOut), marker) {
			t.Errorf("hermes doctor reports provider config problem (%q) — config/auth/.env copy incomplete", marker)
		}
	}
}
