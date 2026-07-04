package agentruntime

import (
	"errors"
	"time"

	runtimepaths "github.com/tutti-os/tutti/packages/agentactivity/daemon/internal/runtimepaths"
)

const (
	nexightACPCommand     = "nexight-acp"
	codexAgentRoutingEnv  = "TUTTI_AGENT_ROUTING=1"
	codexRoutingPreload   = "LD_PRELOAD=" + runtimepaths.BundlePreloadSOPath
	acpMethodInitialize   = "initialize"
	acpMethodAuthenticate = "authenticate"
	acpMethodNewSession   = "session/new"
	acpMethodLoadSession  = "session/load"
	acpMethodResume       = "session/resume"
	acpMethodPrompt       = "session/prompt"
	acpMethodCancel       = "session/cancel"
	acpMethodUpdate       = "session/update"
	acpMethodPermission   = "session/request_permission"
	acpMethodSetMode      = "session/set_mode"
	acpProtocolVersion    = 1
	acpStartCallTimeout   = 30 * time.Second
)

var acpPermissionModeTimeout = 10 * time.Second

var errPermissionRequestCanceled = errors.New("permission request canceled")
