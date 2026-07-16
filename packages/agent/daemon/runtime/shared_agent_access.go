package agentruntime

import (
	"context"
	"strings"
)

const (
	SharedAgentAccessStart    = "start"
	SharedAgentAccessResume   = "resume"
	SharedAgentAccessTurn     = "turn"
	SharedAgentAccessSettings = "settings"
	SharedAgentAccessRelease  = "release"

	AppErrorSharedAgentOwnerOffline       = "agent.shared_owner_offline"
	AppErrorSharedAgentQuotaExhausted     = "agent.shared_quota_exhausted"
	AppErrorSharedAgentConcurrencyLimit   = "agent.shared_concurrency_limit"
	AppErrorSharedAgentAccessUnavailable  = "agent.shared_access_unavailable"
	AppErrorSharedAgentAuditUnavailable   = "agent.shared_audit_unavailable"
	AppErrorSharedAgentAuthorizationError = "agent.shared_authorization_failed"
)

type SharedAgentAccessRequest struct {
	Action            string
	RoomID            string
	AgentSessionID    string
	AgentTargetID     string
	Provider          string
	GrantID           string
	OwnerUserID       string
	ModelPlanID       string
	Model             string
	Capability        string
	ProviderTargetRef map[string]any
}

type SharedAgentAccessAuditRecord struct {
	SharedAgentAccessRequest
	Outcome string
	Reason  string
}

// SharedAgentAccessController is implemented by the host control plane. Start
// and resume acquire a concurrency lease, turn re-checks quota/owner presence,
// and release frees the lease. It must never return provider credentials.
type SharedAgentAccessController interface {
	ApplySharedAgentAccess(context.Context, SharedAgentAccessRequest) error
}

// SharedAgentAccessAuditor records allowed and denied access decisions outside
// the local conversation store. Every shared-Agent request fails closed when
// this hook is absent or fails; an untrusted launch snapshot cannot opt out.
type SharedAgentAccessAuditor interface {
	RecordSharedAgentAccess(context.Context, SharedAgentAccessAuditRecord) error
}

// ConfigureSharedAgentAccess installs the host-owned authority and audit sink.
// Hosts must call it during startup, before exposing the Controller to callers.
func (c *Controller) ConfigureSharedAgentAccess(controller SharedAgentAccessController, auditor SharedAgentAccessAuditor) {
	c.sharedAgentAccessController = controller
	c.sharedAgentAccessAuditor = auditor
}

type projectedSharedAgentIdentity struct {
	GrantID     string
	OwnerUserID string
}

func sharedAgentAccessRequestForSession(action string, session Session) SharedAgentAccessRequest {
	return SharedAgentAccessRequest{
		Action:            action,
		RoomID:            session.RoomID,
		AgentSessionID:    session.AgentSessionID,
		AgentTargetID:     session.AgentTargetID,
		Provider:          session.Provider,
		ModelPlanID:       sharedAgentModelPlanID(session.RuntimeContext),
		Model:             strings.TrimSpace(session.SettingsValue().Model),
		ProviderTargetRef: clonePayload(session.ProviderTargetRef),
	}
}

func sharedAgentModelPlanID(runtimeContext map[string]any) string {
	if len(runtimeContext) == 0 {
		return ""
	}
	if value := strings.TrimSpace(asString(runtimeContext["modelPlanId"])); value != "" {
		return value
	}
	configuration, _ := runtimeContext["modelConfiguration"].(map[string]any)
	return strings.TrimSpace(asString(configuration["modelPlanId"]))
}

func sharedAgentCapability(metadata map[string]any) string {
	for _, key := range []string{"collaborationMode", "automationAction", "capability"} {
		if value := strings.TrimSpace(asString(metadata[key])); value != "" {
			return value
		}
	}
	return ""
}

func (c *Controller) applySharedAgentAccess(ctx context.Context, request SharedAgentAccessRequest) error {
	if !isSharedAgentAccessRequest(request) {
		return nil
	}
	identity, ok := sharedAgentIdentityFromTargetRef(request.ProviderTargetRef)
	if !ok {
		err := sharedAgentAccessAppError(
			AppErrorSharedAgentAccessUnavailable,
			"shared Agent access identity is missing or invalid",
			nil,
		)
		_ = c.auditSharedAgentAccess(ctx, request, "denied", AppErrorCode(err), true)
		return err
	}
	request.GrantID = identity.GrantID
	request.OwnerUserID = identity.OwnerUserID

	if c.sharedAgentAccessAuditor == nil {
		return sharedAgentAccessAppError(
			AppErrorSharedAgentAuditUnavailable,
			"shared Agent access requires an audit recorder",
			nil,
		)
	}
	if c.sharedAgentAccessController == nil {
		err := sharedAgentAccessAppError(
			AppErrorSharedAgentAccessUnavailable,
			"shared Agent control plane is unavailable",
			nil,
		)
		_ = c.auditSharedAgentAccess(ctx, request, "denied", AppErrorCode(err), true)
		return err
	}
	// Owner presence, quota and concurrency in ProviderTargetRef are UI-only
	// snapshots. The control plane must re-read current state and atomically
	// acquire/revalidate/release the shared grant for every lifecycle action.
	if err := c.sharedAgentAccessController.ApplySharedAgentAccess(ctx, request); err != nil {
		code := AppErrorCode(err)
		if code == "" {
			code = AppErrorSharedAgentAuthorizationError
			err = sharedAgentAccessAppError(code, "shared Agent authorization failed", err)
		}
		_ = c.auditSharedAgentAccess(ctx, request, "denied", code, true)
		return err
	}
	if err := c.auditSharedAgentAccess(ctx, request, "allowed", "", true); err != nil {
		if request.Action == SharedAgentAccessStart || request.Action == SharedAgentAccessResume {
			release := request
			release.Action = SharedAgentAccessRelease
			_ = c.sharedAgentAccessController.ApplySharedAgentAccess(ctx, release)
		}
		return err
	}
	return nil
}

func (c *Controller) auditSharedAgentAccess(ctx context.Context, request SharedAgentAccessRequest, outcome string, reason string, required bool) error {
	if c.sharedAgentAccessAuditor == nil {
		if required {
			return sharedAgentAccessAppError(AppErrorSharedAgentAuditUnavailable, "shared Agent audit recorder is unavailable", nil)
		}
		return nil
	}
	if err := c.sharedAgentAccessAuditor.RecordSharedAgentAccess(ctx, SharedAgentAccessAuditRecord{
		SharedAgentAccessRequest: request,
		Outcome:                  outcome,
		Reason:                   reason,
	}); err != nil && required {
		return sharedAgentAccessAppError(AppErrorSharedAgentAuditUnavailable, "shared Agent audit write failed", err)
	}
	return nil
}

func isSharedAgentAccessRequest(request SharedAgentAccessRequest) bool {
	targetID := strings.ToLower(strings.TrimSpace(request.AgentTargetID))
	if strings.HasPrefix(targetID, "shared-agent:") {
		return true
	}
	kind := strings.ToLower(strings.TrimSpace(asString(request.ProviderTargetRef["kind"])))
	if kind == "shared-agent" {
		return true
	}
	_, hasSharedAccess := request.ProviderTargetRef["sharedAccess"]
	return hasSharedAccess
}

func sharedAgentIdentityFromTargetRef(ref map[string]any) (projectedSharedAgentIdentity, bool) {
	raw, ok := ref["sharedAccess"].(map[string]any)
	if !ok {
		return projectedSharedAgentIdentity{}, false
	}
	identity := projectedSharedAgentIdentity{
		GrantID:     strings.TrimSpace(asString(raw["grantId"])),
		OwnerUserID: strings.TrimSpace(asString(raw["ownerUserId"])),
	}
	return identity, identity.GrantID != "" && identity.OwnerUserID != ""
}

func sharedAgentAccessAppError(code string, debugMessage string, cause error) error {
	return &AppError{
		Code:         code,
		Message:      code,
		DebugMessage: debugMessage,
		Cause:        cause,
	}
}
