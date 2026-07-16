package agentruntime

import (
	"context"
	"sync"
	"testing"
)

type recordingSharedAgentAccessController struct {
	mu       sync.Mutex
	requests []SharedAgentAccessRequest
	err      error
}

func (c *recordingSharedAgentAccessController) ApplySharedAgentAccess(_ context.Context, request SharedAgentAccessRequest) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.requests = append(c.requests, request)
	return c.err
}

type recordingSharedAgentAccessAuditor struct {
	mu      sync.Mutex
	records []SharedAgentAccessAuditRecord
}

func (a *recordingSharedAgentAccessAuditor) RecordSharedAgentAccess(_ context.Context, record SharedAgentAccessAuditRecord) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.records = append(a.records, record)
	return nil
}

func TestControllerDefersStaleSharedAgentSnapshotToAuthority(t *testing.T) {
	adapter := &recordingStartAdapter{provider: ProviderCodex}
	access := &recordingSharedAgentAccessController{}
	auditor := &recordingSharedAgentAccessAuditor{}
	controller := NewController([]Adapter{adapter}, nil)
	controller.ConfigureSharedAgentAccess(access, auditor)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:            "room-1",
		AgentSessionID:    "session-1",
		AgentTargetID:     "shared-agent:one",
		Provider:          ProviderCodex,
		CWD:               "/workspace",
		ProviderTargetRef: sharedAgentTargetRef(false, 1000, 0, 1),
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if started.Session.AgentSessionID != "session-1" || len(access.requests) != 1 {
		t.Fatalf("start = %#v, authority requests = %#v", started, access.requests)
	}
}

func TestControllerFailsClosedWhenSharedTargetAccessMetadataIsMissing(t *testing.T) {
	adapter := &recordingStartAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, nil)
	controller.ConfigureSharedAgentAccess(
		&recordingSharedAgentAccessController{},
		&recordingSharedAgentAccessAuditor{},
	)

	_, err := controller.Start(context.Background(), StartInput{
		RoomID: "room-1", AgentSessionID: "session-1", AgentTargetID: "shared-agent:one",
		Provider: ProviderCodex, CWD: "/workspace", ProviderTargetRef: map[string]any{
			"kind": "shared-agent", "provider": ProviderCodex,
		},
	})
	if AppErrorCode(err) != AppErrorSharedAgentAccessUnavailable {
		t.Fatalf("Start() error = %v (%q), want access unavailable", err, AppErrorCode(err))
	}
	if adapter.started.AgentSessionID != "" {
		t.Fatalf("adapter started unexpectedly: %#v", adapter.started)
	}
}

func TestControllerRequiresAuditForEverySharedTarget(t *testing.T) {
	adapter := &recordingStartAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, nil)
	controller.ConfigureSharedAgentAccess(&recordingSharedAgentAccessController{}, nil)
	ref := sharedAgentTargetRef(true, 1000, 0, 1)
	ref["sharedAccess"].(map[string]any)["auditRequired"] = false

	_, err := controller.Start(context.Background(), StartInput{
		RoomID: "room-1", AgentSessionID: "session-1", AgentTargetID: "shared-agent:one",
		Provider: ProviderCodex, CWD: "/workspace", ProviderTargetRef: ref,
		Settings: &SessionSettings{Model: "model-a"},
		RuntimeContext: map[string]any{
			"modelConfiguration": map[string]any{"modelPlanId": "plan-owner"},
		},
	})
	if AppErrorCode(err) != AppErrorSharedAgentAuditUnavailable {
		t.Fatalf("Start() error = %v (%q), want audit unavailable", err, AppErrorCode(err))
	}
}

func TestControllerUsesSharedAccessControlPlaneForStartTurnAndRelease(t *testing.T) {
	adapter := &recordingStartAdapter{provider: ProviderCodex}
	access := &recordingSharedAgentAccessController{}
	auditor := &recordingSharedAgentAccessAuditor{}
	controller := NewController([]Adapter{adapter}, nil)
	controller.sharedAgentAccessController = access
	controller.sharedAgentAccessAuditor = auditor
	ref := sharedAgentTargetRef(true, 1000, 0, 2)

	_, err := controller.Start(context.Background(), StartInput{
		RoomID: "room-1", AgentSessionID: "session-1", AgentTargetID: "shared-agent:one",
		Provider: ProviderCodex, CWD: "/workspace", ProviderTargetRef: ref,
		Settings: &SessionSettings{Model: "model-a"},
		RuntimeContext: map[string]any{
			"modelConfiguration": map[string]any{"modelPlanId": "plan-owner"},
		},
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if _, err := controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID: "room-1", AgentSessionID: "session-1",
		Settings: SessionSettingsPatch{Model: stringPtr("model-b")},
	}); err != nil {
		t.Fatalf("UpdateSettings() error = %v", err)
	}
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID: "room-1", AgentSessionID: "session-1",
		Content:  []PromptContentBlock{{Type: "text", Text: "hello"}},
		Metadata: map[string]any{"collaborationMode": "delegate"},
	}); err != nil {
		t.Fatalf("Exec() error = %v", err)
	}
	if _, err := controller.Close(context.Background(), CloseInput{RoomID: "room-1", AgentSessionID: "session-1"}); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	access.mu.Lock()
	actions := make([]string, 0, len(access.requests))
	for _, request := range access.requests {
		actions = append(actions, request.Action)
		if request.GrantID != "grant-1" || request.OwnerUserID != "owner-1" {
			t.Fatalf("access identity = %#v", request)
		}
	}
	access.mu.Unlock()
	if len(actions) != 4 || actions[0] != SharedAgentAccessStart || actions[1] != SharedAgentAccessSettings || actions[2] != SharedAgentAccessTurn || actions[3] != SharedAgentAccessRelease {
		t.Fatalf("actions = %#v", actions)
	}
	if access.requests[0].ModelPlanID != "plan-owner" || access.requests[0].Model != "model-a" {
		t.Fatalf("start model authority = %#v", access.requests[0])
	}
	if access.requests[1].Model != "model-b" || access.requests[2].Model != "model-b" || access.requests[2].Capability != "delegate" {
		t.Fatalf("settings/turn authority = %#v", access.requests)
	}
	auditor.mu.Lock()
	defer auditor.mu.Unlock()
	if len(auditor.records) != 4 {
		t.Fatalf("audit records = %#v", auditor.records)
	}
	for _, record := range auditor.records {
		if record.Outcome != "allowed" {
			t.Fatalf("audit record = %#v", record)
		}
	}
}

func sharedAgentTargetRef(ownerOnline bool, remainingTokens float64, active float64, limit float64) map[string]any {
	return map[string]any{
		"kind":          "agent-directory",
		"provider":      ProviderCodex,
		"agentTargetId": "shared-agent:one",
		"sharedAccess": map[string]any{
			"grantId":       "grant-1",
			"ownerUserId":   "owner-1",
			"ownerOnline":   ownerOnline,
			"auditRequired": true,
			"quota": map[string]any{
				"unit":      "tokens",
				"remaining": remainingTokens,
			},
			"concurrency": map[string]any{
				"active": active,
				"limit":  limit,
			},
		},
	}
}
