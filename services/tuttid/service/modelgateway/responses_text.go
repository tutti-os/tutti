package modelgateway

import (
	"bytes"
	"encoding/json"
	"fmt"
)

func convertResponseTextControls(encoded json.RawMessage) (string, map[string]any, error) {
	trimmed := bytes.TrimSpace(encoded)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return "", nil, nil
	}
	var controls struct {
		Verbosity string          `json:"verbosity"`
		Format    json.RawMessage `json:"format"`
	}
	if err := json.Unmarshal(trimmed, &controls); err != nil {
		return "", nil, invalidParam("text", "text controls must be an object")
	}
	formatBytes := bytes.TrimSpace(controls.Format)
	if len(formatBytes) == 0 || bytes.Equal(formatBytes, []byte("null")) {
		return controls.Verbosity, nil, nil
	}
	var format map[string]any
	if err := json.Unmarshal(formatBytes, &format); err != nil {
		return "", nil, invalidParam("text.format", "text.format must be an object")
	}
	formatType, _ := format["type"].(string)
	switch formatType {
	case "", "text":
		return controls.Verbosity, nil, nil
	case "json_object":
		return controls.Verbosity, map[string]any{"type": "json_object"}, nil
	case "json_schema":
		jsonSchema := map[string]any{}
		for _, field := range []string{"name", "description", "schema", "strict"} {
			if value, ok := format[field]; ok {
				jsonSchema[field] = value
			}
		}
		return controls.Verbosity, map[string]any{
			"type":        "json_schema",
			"json_schema": jsonSchema,
		}, nil
	default:
		return "", nil, invalidParam("text.format.type", fmt.Sprintf("text format %q is not supported", formatType))
	}
}
