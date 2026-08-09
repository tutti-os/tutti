package command

import "testing"

func TestValidateInputSchemaRejectsUnenforcedKeywords(t *testing.T) {
	if err := ValidateInputSchema(map[string]any{"type": "object", "properties": map[string]any{
		"query": map[string]any{"type": "string"}}, "additionalProperties": false}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateInputSchema(map[string]any{"type": "string", "pattern": "^trusted$"}); err == nil {
		t.Fatal("unsupported pattern keyword was accepted")
	}
}
