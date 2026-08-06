package cli

import "testing"

func TestValidateCapabilityInputSchemaRejectsConstraintsTheInvokerCannotEnforce(t *testing.T) {
	for name, schema := range map[string]map[string]any{
		"ref":      {"type": "object", "$ref": "#/$defs/input", "$defs": map[string]any{}},
		"nullable": {"type": []any{"object", "null"}},
		"pattern":  {"type": "object", "properties": map[string]any{"name": map[string]any{"type": "string", "pattern": "^[a-z]+$"}}},
	} {
		t.Run(name, func(t *testing.T) {
			if err := ValidateCapabilityInputSchema(schema); err == nil {
				t.Fatalf("unsupported schema was accepted: %#v", schema)
			}
		})
	}
}

func TestValidateCapabilityInputSchemaAcceptsFullyEnforcedSubset(t *testing.T) {
	schema := map[string]any{"type": "object", "additionalProperties": false, "required": []any{"count"},
		"properties": map[string]any{
			"count": map[string]any{"type": "integer", "minimum": float64(1), "maximum": float64(10)},
			"mode":  map[string]any{"type": "string", "enum": []any{"safe", "fast"}},
			"tags":  map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		}}
	if err := ValidateCapabilityInputSchema(schema); err != nil {
		t.Fatal(err)
	}
}
