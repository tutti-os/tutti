package main

import (
	"context"
	"testing"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

type runtimePrepCatalogStub struct {
	context      cliservice.InvokeContext
	capabilities []cliservice.Capability
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
		Source:                "agent-runtime",
		WorkspaceID:           "workspace-1",
		SkipCapabilityFilters: true,
	})
	if stub.context.Source != "agent-runtime" ||
		stub.context.WorkspaceID != "workspace-1" ||
		!stub.context.SkipCapabilityFilters {
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
