package computer

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestParseToolResultPreservesStructuredContent(t *testing.T) {
	raw := json.RawMessage(`{
  "isError": false,
  "content": [
    {"type": "text", "text": "captured"},
    {"type": "image", "data": "aW1hZ2U=", "mimeType": "image/png"}
  ],
  "structuredContent": {
    "screenshot_file_path": "/tmp/screenshot.png",
    "screen_width": 1512,
    "scale_factor": 2
  }
}`)

	result, err := parseToolResult(raw)
	if err != nil {
		t.Fatalf("parseToolResult: %v", err)
	}
	if result.Text != "captured" || len(result.Images) != 1 {
		t.Fatalf("result = %#v", result)
	}
	want := map[string]any{
		"screenshot_file_path": "/tmp/screenshot.png",
		"screen_width":         float64(1512),
		"scale_factor":         float64(2),
	}
	if !reflect.DeepEqual(result.StructuredContent, want) {
		t.Fatalf("structured content = %#v, want %#v", result.StructuredContent, want)
	}
}

func TestParseToolResultPreservesUnknownNativeContent(t *testing.T) {
	raw := json.RawMessage(`{
  "isError": false,
  "content": [{"type":"resource_link","uri":"file:///tmp/state.json","name":"state"}],
  "structuredContent": {"revision": 7},
  "futureField": {"kept": true}
}`)

	result, err := parseToolResult(raw)
	if err != nil {
		t.Fatalf("parseToolResult: %v", err)
	}
	if !reflect.DeepEqual(result.Raw, raw) {
		t.Fatalf("raw result = %s, want %s", result.Raw, raw)
	}
}

func TestParseToolResultPreservesNativeErrorResultWithoutTransportError(t *testing.T) {
	raw := json.RawMessage(`{
  "isError": true,
  "content": [{"type":"text","text":"target disappeared"}],
  "structuredContent": {"code":"stale_target"}
}`)

	result, err := parseToolResult(raw)
	if err != nil {
		t.Fatalf("parseToolResult returned transport error: %v", err)
	}
	if !result.IsError || result.Text != "target disappeared" || !reflect.DeepEqual(result.Raw, raw) {
		t.Fatalf("result = %#v", result)
	}
}

func TestParseToolCatalogPreservesDriverMetadata(t *testing.T) {
	raw := json.RawMessage(`{
  "schema_version": "1",
  "capability_version": "1",
  "tools": [{
    "name": "get_desktop_state",
    "description": "Capture the display",
    "inputSchema": {
      "type": "object",
      "properties": {"screenshot_out_file": {"type": "string"}}
    },
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "capabilities": ["screen.capture", "screen.dimensions"]
  }]
}`)

	catalog, err := parseToolCatalog(raw)
	if err != nil {
		t.Fatalf("parseToolCatalog: %v", err)
	}
	if catalog.SchemaVersion != "1" || catalog.CapabilityVersion != "1" || len(catalog.Tools) != 1 {
		t.Fatalf("catalog = %#v", catalog)
	}
	tool := catalog.Tools[0]
	if tool.Name != "get_desktop_state" || tool.Description != "Capture the display" {
		t.Fatalf("tool = %#v", tool)
	}
	if !tool.Annotations.ReadOnly || tool.Annotations.Destructive || tool.Annotations.Idempotent || tool.Annotations.OpenWorld {
		t.Fatalf("annotations = %#v", tool.Annotations)
	}
	if !reflect.DeepEqual(tool.Capabilities, []string{"screen.capture", "screen.dimensions"}) {
		t.Fatalf("capabilities = %#v", tool.Capabilities)
	}
	properties := tool.InputSchema["properties"].(map[string]any)
	if properties["screenshot_out_file"].(map[string]any)["type"] != "string" {
		t.Fatalf("input schema = %#v", tool.InputSchema)
	}
}
