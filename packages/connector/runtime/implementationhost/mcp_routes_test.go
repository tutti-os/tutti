package implementationhost

import (
	"context"
	"encoding/json"
	"testing"
)

type fixedMCPCaller struct {
	result json.RawMessage
}

func (caller fixedMCPCaller) Call(context.Context, string, any) (json.RawMessage, error) {
	return caller.result, nil
}

func TestListModernMCPToolsAcceptsStandardResponseWithoutResultTypeExtension(t *testing.T) {
	tools, err := listModernMCPTools(context.Background(), fixedMCPCaller{result: json.RawMessage(
		`{"tools":[{"name":"search","description":"Search","inputSchema":{"type":"object"}}]}`,
	)})
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 1 || tools[0].Name != "search" {
		t.Fatalf("tools = %#v", tools)
	}
}

func TestListModernMCPToolsRejectsExplicitIncompleteResponse(t *testing.T) {
	_, err := listModernMCPTools(context.Background(), fixedMCPCaller{result: json.RawMessage(
		`{"resultType":"partial","tools":[{"name":"search","inputSchema":{"type":"object"}}]}`,
	)})
	if err == nil {
		t.Fatal("explicit incomplete tools/list response was accepted")
	}
}
