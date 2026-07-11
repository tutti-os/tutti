package api

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	cliruntime "github.com/tutti-os/tutti/packages/cli/runtime"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

func TestCLIRuntimeDTOsConformToGeneratedOpenAPI(t *testing.T) {
	assertJSONFieldInventory[tuttigenerated.CliCapability, cliruntime.Capability](t)
	assertJSONFieldInventory[tuttigenerated.CliCapabilitiesResponse, cliruntime.CapabilityList](t)
	assertJSONFieldInventory[tuttigenerated.CliCapabilityOutput, cliruntime.CapabilityOutput](t)
	assertJSONFieldInventory[tuttigenerated.CliCapabilitySource, cliruntime.CapabilitySource](t)
	assertJSONFieldInventory[tuttigenerated.CliTableOutput, cliruntime.TableOutput](t)
	assertJSONFieldInventory[tuttigenerated.CliTableColumn, cliruntime.TableColumn](t)
	assertJSONFieldInventory[tuttigenerated.CliInvokeContext, cliruntime.InvokeContext](t)
	assertJSONFieldInventory[tuttigenerated.CliInvokeRequest, cliruntime.InvokeRequest](t)
	assertJSONFieldInventory[tuttigenerated.CliCommandOutput, cliruntime.CommandOutput](t)
	assertJSONFieldInventory[tuttigenerated.CliCommandWarning, cliruntime.CommandWarning](t)
	assertJSONFieldInventory[tuttigenerated.CliInvokeResponse, cliruntime.InvokeResponse](t)
	assertJSONFieldInventory[tuttigenerated.ApiErrorResponse, cliruntime.APIErrorResponse](t)
	assertJSONFieldInventory[tuttigenerated.ApiErrorDetails, cliruntime.APIErrorDetails](t)

	description := "description"
	visibility := tuttigenerated.Integration
	appID := "app-1"
	appName := "App"
	iconURL := "data:image/png;base64,AA=="
	cliDescription := "CLI description"
	appDescription := "App description"
	documentationFile := "COMMANDS.md"
	documentationPath := "/package/COMMANDS.md"
	inputSchema := map[string]any{"type": "object", "properties": map[string]any{"count": map[string]any{"type": "integer"}}}
	capability := tuttigenerated.CliCapability{
		Id:          "app.command",
		Path:        []string{"app", "command"},
		Summary:     "Summary",
		Description: &description,
		Visibility:  &visibility,
		InputSchema: &inputSchema,
		Output: tuttigenerated.CliCapabilityOutput{
			DefaultMode: tuttigenerated.Table,
			Json:        true,
			Table: &tuttigenerated.CliTableOutput{Columns: []tuttigenerated.CliTableColumn{{
				Key: "id", Label: "ID",
			}}},
		},
		Source: tuttigenerated.CliCapabilitySource{
			Kind:              tuttigenerated.App,
			AppId:             &appID,
			AppName:           &appName,
			IconUrl:           &iconURL,
			CliDescription:    &cliDescription,
			AppDescription:    &appDescription,
			DocumentationFile: &documentationFile,
			DocumentationPath: &documentationPath,
		},
	}
	assertJSONContract[tuttigenerated.CliCapability, cliruntime.Capability](t, capability)
	assertJSONContract[tuttigenerated.CliCapabilitiesResponse, cliruntime.CapabilityList](t, tuttigenerated.CliCapabilitiesResponse{
		Commands: []tuttigenerated.CliCapability{capability},
	})

	workspaceID := "workspace-1"
	parentCommandID := "parent-1"
	agentSessionID := "session-1"
	outputMode := tuttigenerated.Json
	invokeInput := map[string]any{"count": "2", "present": false}
	assertJSONContract[tuttigenerated.CliInvokeRequest, cliruntime.InvokeRequest](t, tuttigenerated.CliInvokeRequest{
		Input:      &invokeInput,
		OutputMode: &outputMode,
		Context: &tuttigenerated.CliInvokeContext{
			Source:          "cli",
			WorkspaceID:     &workspaceID,
			ParentCommandId: &parentCommandID,
			AgentSessionId:  &agentSessionID,
		},
	})

	text := "done"
	rows := []map[string]any{{"id": "1"}}
	value := map[string]any{"ok": true}
	columns := []tuttigenerated.CliTableColumn{{Key: "id", Label: "ID"}}
	warnings := []tuttigenerated.CliCommandWarning{{Code: "stale", Message: "Data may be stale."}}
	output := tuttigenerated.CliCommandOutput{
		Kind:     tuttigenerated.Table,
		Columns:  &columns,
		Rows:     &rows,
		Value:    &value,
		Text:     &text,
		Warnings: &warnings,
	}
	assertJSONContract[tuttigenerated.CliCommandOutput, cliruntime.CommandOutput](t, output)
	assertJSONContract[tuttigenerated.CliInvokeResponse, cliruntime.InvokeResponse](t, tuttigenerated.CliInvokeResponse{
		Ok: true, Output: &output,
	})
	reason := "app_cli_runtime_unavailable"
	retryable := true
	developerMessage := "app runtime unavailable"
	params := map[string]any{"appId": "app-1"}
	assertJSONContract[tuttigenerated.ApiErrorResponse, cliruntime.APIErrorResponse](t, tuttigenerated.ApiErrorResponse{
		Error: tuttigenerated.ApiErrorDetails{
			Code:             tuttigenerated.ServiceUnavailable,
			Reason:           &reason,
			Params:           &params,
			Retryable:        &retryable,
			DeveloperMessage: &developerMessage,
		},
	})
}

func TestCLIRuntimeDTOsPreserveOptionalAndEmptyWireShapes(t *testing.T) {
	assertRawJSONContract[tuttigenerated.CliInvokeRequest, cliruntime.InvokeRequest](t, `{"context":null,"input":null,"outputMode":null}`)
	assertRawJSONContract[tuttigenerated.CliCommandOutput, cliruntime.CommandOutput](t, `{"kind":"json","columns":null,"rows":null,"value":null,"text":null,"warnings":null}`)
	assertRawJSONContract[tuttigenerated.CliCapability, cliruntime.Capability](t, `{"id":"nulls","path":["nulls"],"summary":"nulls","description":null,"visibility":null,"inputSchema":null,"output":{"defaultMode":"table","json":false,"table":null},"source":{"kind":"builtin","appId":null,"appName":null,"iconUrl":null,"cliDescription":null,"appDescription":null,"documentationFile":null,"documentationPath":null}}`)
	assertJSONContract[tuttigenerated.CliInvokeRequest, cliruntime.InvokeRequest](t, tuttigenerated.CliInvokeRequest{})
	emptyInput := map[string]any{}
	emptyMode := tuttigenerated.CliOutputMode("")
	assertJSONContract[tuttigenerated.CliInvokeRequest, cliruntime.InvokeRequest](t, tuttigenerated.CliInvokeRequest{
		Input:      &emptyInput,
		OutputMode: &emptyMode,
		Context:    &tuttigenerated.CliInvokeContext{Source: ""},
	})
	emptyColumns := []tuttigenerated.CliTableColumn{}
	emptyRows := []map[string]any{}
	emptyValue := map[string]any{}
	emptyText := ""
	emptyWarnings := []tuttigenerated.CliCommandWarning{}
	assertJSONContract[tuttigenerated.CliCommandOutput, cliruntime.CommandOutput](t, tuttigenerated.CliCommandOutput{
		Kind:     tuttigenerated.Json,
		Columns:  &emptyColumns,
		Rows:     &emptyRows,
		Value:    &emptyValue,
		Text:     &emptyText,
		Warnings: &emptyWarnings,
	})
	emptyDescription := ""
	emptySchema := map[string]any{}
	public := tuttigenerated.Public
	assertJSONContract[tuttigenerated.CliCapability, cliruntime.Capability](t, tuttigenerated.CliCapability{
		Id:          "empty",
		Path:        []string{},
		Summary:     "",
		Description: &emptyDescription,
		Visibility:  &public,
		InputSchema: &emptySchema,
		Output:      tuttigenerated.CliCapabilityOutput{DefaultMode: tuttigenerated.Table},
		Source:      tuttigenerated.CliCapabilitySource{Kind: tuttigenerated.Builtin},
	})
}

func assertRawJSONContract[OpenAPI any, Runtime any](t *testing.T, content string) {
	t.Helper()
	var openAPI OpenAPI
	if err := json.Unmarshal([]byte(content), &openAPI); err != nil {
		t.Fatal(err)
	}
	var runtime Runtime
	if err := json.Unmarshal([]byte(content), &runtime); err != nil {
		t.Fatal(err)
	}
	openAPIJSON, err := json.Marshal(openAPI)
	if err != nil {
		t.Fatal(err)
	}
	runtimeJSON, err := json.Marshal(runtime)
	if err != nil {
		t.Fatal(err)
	}
	assertSemanticJSONEqual(t, openAPIJSON, runtimeJSON)
}

func assertJSONContract[OpenAPI any, Runtime any](t *testing.T, openAPI OpenAPI) {
	t.Helper()
	openAPIJSON, err := json.Marshal(openAPI)
	if err != nil {
		t.Fatal(err)
	}
	var runtime Runtime
	if err := json.Unmarshal(openAPIJSON, &runtime); err != nil {
		t.Fatalf("decode OpenAPI fixture into runtime DTO: %v\n%s", err, openAPIJSON)
	}
	runtimeJSON, err := json.Marshal(runtime)
	if err != nil {
		t.Fatal(err)
	}
	var openAPIRoundTrip OpenAPI
	if err := json.Unmarshal(runtimeJSON, &openAPIRoundTrip); err != nil {
		t.Fatalf("decode runtime DTO into generated OpenAPI type: %v\n%s", err, runtimeJSON)
	}
	assertSemanticJSONEqual(t, openAPIJSON, runtimeJSON)
}

func assertJSONFieldInventory[OpenAPI any, Runtime any](t *testing.T) {
	t.Helper()
	openAPIType := reflect.TypeOf((*OpenAPI)(nil)).Elem()
	runtimeType := reflect.TypeOf((*Runtime)(nil)).Elem()
	openAPIInventory := jsonFieldInventory(openAPIType)
	runtimeInventory := jsonFieldInventory(runtimeType)
	if !reflect.DeepEqual(openAPIInventory, runtimeInventory) {
		t.Fatalf("JSON field inventory mismatch for %s and %s:\nOpenAPI: %#v\nRuntime: %#v", openAPIType, runtimeType, openAPIInventory, runtimeInventory)
	}
}

func jsonFieldInventory(value reflect.Type) map[string]string {
	result := map[string]string{}
	for index := 0; index < value.NumField(); index++ {
		field := value.Field(index)
		tag := field.Tag.Get("json")
		name, _, _ := strings.Cut(tag, ",")
		if name == "" || name == "-" {
			continue
		}
		result[tag] = jsonShape(field.Type)
	}
	return result
}

func jsonShape(value reflect.Type) string {
	switch value.Kind() {
	case reflect.Pointer:
		return "*" + jsonShape(value.Elem())
	case reflect.Slice:
		return "[]" + jsonShape(value.Elem())
	case reflect.Map:
		return "map[" + jsonShape(value.Key()) + "]" + jsonShape(value.Elem())
	case reflect.Interface:
		return "any"
	default:
		return value.Kind().String()
	}
}

func assertSemanticJSONEqual(t *testing.T, left []byte, right []byte) {
	t.Helper()
	var leftValue any
	if err := json.Unmarshal(left, &leftValue); err != nil {
		t.Fatal(err)
	}
	var rightValue any
	if err := json.Unmarshal(right, &rightValue); err != nil {
		t.Fatal(err)
	}
	normalizedLeft, _ := json.Marshal(leftValue)
	normalizedRight, _ := json.Marshal(rightValue)
	if !bytes.Equal(normalizedLeft, normalizedRight) {
		t.Fatalf("JSON contract mismatch:\nOpenAPI: %s\nRuntime: %s", normalizedLeft, normalizedRight)
	}
}
