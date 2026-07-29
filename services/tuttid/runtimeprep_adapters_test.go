package main

import (
	"context"
	"reflect"
	"testing"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

type runtimePrepCatalogStub struct {
	context      cliservice.InvokeContext
	capabilities []cliservice.Capability
}

type agentSessionProjectionStub struct {
	workspaceID string
	sessionID   string
	projection  *runtimeprep.CommandCapabilityProjection
}

func (stub *agentSessionProjectionStub) AgentSessionCommandCapabilityProjection(
	_ context.Context,
	workspaceID string,
	sessionID string,
) (*runtimeprep.CommandCapabilityProjection, error) {
	stub.workspaceID = workspaceID
	stub.sessionID = sessionID
	return stub.projection, nil
}

func (stub *runtimePrepCatalogStub) Capabilities(_ context.Context, input cliservice.InvokeContext) []cliservice.Capability {
	stub.context = input
	return append([]cliservice.Capability(nil), stub.capabilities...)
}

func TestRuntimePrepCommandCatalogPreservesAgentFacingMetadata(t *testing.T) {
	stub := &runtimePrepCatalogStub{capabilities: []cliservice.Capability{{
		ID:          "jobs.wait",
		Path:        []string{"jobs", "wait"},
		Summary:     "Wait for job",
		Description: "Blocks until the job stops.",
		Visibility:  cliservice.CapabilityVisibilityPublic,
		InputSchema: map[string]any{"properties": map[string]any{"job-id": map[string]any{"type": "string"}}},
		Output: cliservice.CapabilityOutput{
			DefaultMode: cliservice.OutputModeTable,
			JSON:        true,
			Table: &cliservice.TableOutput{Columns: []cliservice.TableColumn{{
				Key: "id", Label: "ID",
			}}},
		},
		Execution: &cliservice.CommandExecution{Mode: cliservice.CommandExecutionModeWait},
		Source: cliservice.CapabilitySource{
			Kind:    cliservice.CapabilitySourceApp,
			AppID:   "jobs",
			AppName: "Jobs",
		},
	}}}
	capabilities := (runtimePrepCommandCatalog{Catalog: stub}).Capabilities(t.Context(), runtimeprep.CommandContext{
		Source:                         "agent-runtime",
		WorkspaceID:                    "workspace-1",
		SkipCapabilityFilters:          true,
		IncludeIntegrationCapabilities: true,
	})
	if stub.context.Source != "agent-runtime" ||
		stub.context.WorkspaceID != "workspace-1" ||
		!stub.context.SkipCapabilityFilters ||
		!stub.context.IncludeIntegrationCapabilities {
		t.Fatalf("catalog context = %#v", stub.context)
	}
	if len(capabilities) != 1 {
		t.Fatalf("capabilities = %#v", capabilities)
	}
	got := capabilities[0]
	if got.Visibility != "public" ||
		got.ExecutionMode != "wait" ||
		got.Output.DefaultMode != "table" ||
		!got.Output.JSON ||
		got.Output.Table == nil ||
		len(got.Output.Table.Columns) != 1 ||
		got.Output.Table.Columns[0].Key != "id" ||
		got.Source.Kind != runtimeprep.CommandSourceApp ||
		got.Source.AppID != "jobs" {
		t.Fatalf("mapped capability = %#v", got)
	}
}

func TestAgentSessionCLIProjectionResolverMapsCanonicalSnapshot(t *testing.T) {
	stub := &agentSessionProjectionStub{
		projection: &runtimeprep.CommandCapabilityProjection{
			AllowedIDs: []string{
				"issue-manager.issue.get",
				"tutti-goal-review.goal-review.verdict",
			},
			IncludeIntegrationIDs: []string{
				"tutti-goal-review.goal-review.verdict",
			},
			ExcludeIDs: []string{"issue-manager.issue.update"},
		},
	}
	projection, err := (agentSessionCLIProjectionResolver{
		Sessions: stub,
	}).ResolveAgentSessionCapabilityProjection(
		t.Context(), " workspace-1 ", " review-session-1 ",
	)
	if err != nil {
		t.Fatalf("ResolveAgentSessionCapabilityProjection() error = %v", err)
	}
	if stub.workspaceID != "workspace-1" ||
		stub.sessionID != "review-session-1" ||
		!reflect.DeepEqual(projection.AllowedIDs, []string{
			"issue-manager.issue.get",
			"tutti-goal-review.goal-review.verdict",
		}) ||
		len(projection.IncludeIntegrationIDs) != 1 ||
		projection.IncludeIntegrationIDs[0] !=
			"tutti-goal-review.goal-review.verdict" ||
		len(projection.ExcludeIDs) != 1 ||
		projection.ExcludeIDs[0] != "issue-manager.issue.update" {
		t.Fatalf("projection = %#v stub=%#v", projection, stub)
	}
}
