package agentruntime

import (
	"errors"
	"time"

	runtimepaths "github.com/tutti-os/tutti/packages/agent/daemon/internal/runtimepaths"
)

const (
	nexightACPCommand    = "nexight-acp"
	codexAgentRoutingEnv = "TUTTI_AGENT_ROUTING=1"
	codexRoutingPreload  = "LD_PRELOAD=" + runtimepaths.BundlePreloadSOPath
	// Codex app-server emits its tracing spans through stderr. Keep the
	// managed process output structured so the runtime trace can preserve
	// thread/start's internal phases for diagnostics.
	codexAppServerLogFormatEnv = "LOG_FORMAT=json"
	codexAppServerRustLogEnv   = "RUST_LOG=codex_app_server=info,codex_core=info"
	// Standard ACP providers run headlessly and must never block on a Git
	// credential or terminal prompt while building workspace context.
	gitTerminalPromptEnv = "GIT_TERMINAL_PROMPT=0"
	// Workspace snapshots are read-only; avoid waiting on optional Git index
	// locks held by another desktop/runtime process.
	gitOptionalLocksEnv        = "GIT_OPTIONAL_LOCKS=0"
	acpMethodInitialize        = "initialize"
	acpMethodAuthenticate      = "authenticate"
	acpMethodNewSession        = "session/new"
	acpMethodLoadSession       = "session/load"
	acpMethodResume            = "session/resume"
	acpMethodPrompt            = "session/prompt"
	acpMethodCancel            = "session/cancel"
	acpMethodUpdate            = "session/update"
	acpMethodPermission        = "session/request_permission"
	acpMethodSetMode           = "session/set_mode"
	cursorACPMethodAskQuestion = "cursor/ask_question"
	cursorACPMethodCreatePlan  = "cursor/create_plan"
	acpProtocolVersion         = 1
	acpStartCallTimeout        = 30 * time.Second
)

var acpPermissionModeTimeout = 10 * time.Second

var errPermissionRequestCanceled = errors.New("permission request canceled")
