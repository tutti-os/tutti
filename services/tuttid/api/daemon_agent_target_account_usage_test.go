package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	agentextensionservice "github.com/tutti-os/tutti/services/tuttid/service/agentextension"
)

type stubAgentTargetAccountUsageService struct {
	probe func(context.Context, string) (agentextensionservice.AccountUsageResult, error)
}

func (service stubAgentTargetAccountUsageService) Probe(
	ctx context.Context,
	targetID string,
) (agentextensionservice.AccountUsageResult, error) {
	return service.probe(ctx, targetID)
}

func TestDaemonAgentTargetAccountUsageReturnsTargetScopedStandardResult(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentTargetAccountUsage: stubAgentTargetAccountUsageService{
			probe: func(_ context.Context, targetID string) (agentextensionservice.AccountUsageResult, error) {
				if targetID != "extension:kimi-code" {
					t.Fatalf("target id = %q", targetID)
				}
				reset := int64(1_800_000_000_000)
				return agentextensionservice.AccountUsageResult{
					SchemaVersion:    agentextensionservice.AccountUsageSchemaVersion,
					AgentTargetID:    targetID,
					Provider:         "acp:kimi-code",
					Outcome:          "available",
					CapturedAtUnixMS: 1_700_000_000_000,
					BillingMode:      "subscription",
					Quotas: []agentextensionservice.AccountUsageQuota{{
						QuotaType: "weekly", PercentRemaining: 72, ResetsAtUnixMS: &reset,
					}},
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/agent-targets/extension:kimi-code/account-usage",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response["schemaVersion"] != agentextensionservice.AccountUsageSchemaVersion ||
		response["agentTargetId"] != "extension:kimi-code" ||
		response["provider"] != "acp:kimi-code" ||
		response["outcome"] != "available" {
		t.Fatalf("response identity/outcome = %#v", response)
	}
	if _, exists := response["errorMessage"]; exists {
		t.Fatalf("response exposed free-form error text: %#v", response)
	}
}
