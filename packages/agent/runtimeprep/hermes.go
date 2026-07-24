package runtimeprep

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// hermesHomeEnv 是 hermes-agent 的数据根环境变量。hermes 从 $HERMES_HOME/skills/
// 与 $HERMES_HOME/config.yaml 的 skills.external_dirs 发现 skill，并把 config.yaml
// （model/provider 接线）与 auth.json（凭证）锚定在 HERMES_HOME 下。
const hermesHomeEnv = "HERMES_HOME"

// hermesGlobalHomeFiles 是必须从用户全局 hermes home 复制进 per-session home 的
// 文件：缺 config.yaml 复现 "No LLM provider configured"，缺 auth.json 则无凭证，
// 缺 .env 则 provider 的 API key（如 OPENCODE_ZEN_API_KEY，hermes 从 HERMES_HOME/.env
// 加载）丢失，复现 "no API key was found"。复制为 opaque 字节，不解析、不日志，凭证不进
// manifest。SOUL.md（persona）与 state.db/sessions/memories（状态）不复制，per-session
// 保持干净；hermes 缺 SOUL.md 不报错，仅用默认 persona。
var hermesGlobalHomeFiles = []string{"config.yaml", "auth.json", ".env"}

// HermesPreparer 为 hermes agent extension（provider id "acp:hermes"）准备 per-session
// HERMES_HOME。hermes-agent 不读 extension 声明的 .agent_context/skills（grep 零命中），
// 只读 $HERMES_HOME/skills/，因此 tutti skill 必须物化到那里才能进 hermes 的
// progressive-disclosure skill 索引，使 agent 能响应 AGENTS.md 里 mention://agent-target
// 的 handoff 路由。per-session HERMES_HOME 隔离 sessions/memories，并避免共享目录下
// allocateSkillName 的 -tutti/-tutti-N 碰撞后缀。AGENTS.md 仍写到 cwd，与其它
// instruction-file provider 一致。
type HermesPreparer struct{}

func (HermesPreparer) Provider() string {
	return "acp:hermes"
}

func (HermesPreparer) Prepare(_ context.Context, input ProviderPrepareInput) (ProviderPrepareResult, error) {
	agentsPath := filepath.Join(input.Cwd, "AGENTS.md")
	policy, err := tuttiCLIPolicy(input.PrepareInput)
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	writeResult, err := input.Store.WriteManagedBlock(agentsPath, policy)
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	if input.Manifest != nil {
		input.Manifest.RecordManagedFile(agentsPath, "provider-instructions", writeResult.Created)
	}

	hermesHome := filepath.Join(input.RuntimeRoot, "hermes")
	if err := os.MkdirAll(hermesHome, 0o700); err != nil {
		return ProviderPrepareResult{}, fmt.Errorf("create per-session hermes home: %w", err)
	}

	// 从用户全局 hermes home 复制 config.yaml + auth.json，使 hermes 能接上 LLM
	// provider。全局 home = 未被 tutti 覆盖时 hermes 本会用的目录：已设 HERMES_HOME
	// 则用它，否则平台默认 ~/.hermes。
	globalHome := resolveGlobalHermesHome()
	for _, name := range hermesGlobalHomeFiles {
		if err := copyHermesHomeFile(filepath.Join(globalHome, name), filepath.Join(hermesHome, name)); err != nil {
			return ProviderPrepareResult{}, err
		}
	}

	// tutti skill 物化到 $HERMES_HOME/skills/（hermes 原生发现路径）。fresh per-session
	// 目录无碰撞，allocateSkillName 直接用 baseName，无 -tutti 后缀。
	skillPaths, err := installProviderNativeSkills(filepath.Join(hermesHome, "skills"), input.PrepareInput)
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	if input.Manifest != nil {
		input.Manifest.RecordManagedFile(hermesHome, "provider-hermes-home", true)
		for _, skillPath := range skillPaths {
			input.Manifest.RecordManagedFile(skillPath, "provider-skill", true)
		}
	}

	return ProviderPrepareResult{
		Cwd: input.Cwd,
		Env: []string{hermesHomeEnv + "=" + hermesHome},
	}, nil
}

// resolveGlobalHermesHome 返回未被 tutti 覆盖时 hermes 会用的 home 目录。daemon 进程
// 通常未设 HERMES_HOME，故回退 ~/.hermes。
func resolveGlobalHermesHome() string {
	if v := strings.TrimSpace(os.Getenv(hermesHomeEnv)); v != "" {
		return v
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".hermes")
	}
	return ""
}

// copyHermesHomeFile 以 opaque 字节复制单个 hermes home 文件。源不存在时跳过
// （用户尚未 setup hermes，交由 hermes 自身报错，不由 tutti 掩盖）。
func copyHermesHomeFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read hermes %s: %w", filepath.Base(src), err)
	}
	return os.WriteFile(dst, data, 0o600)
}
