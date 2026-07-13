package eventstream

import (
	"encoding/json"
	"fmt"
)

func requireJSONFields(raw json.RawMessage, objectKey string, fields ...string) error {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(raw, &root); err != nil {
		return fmt.Errorf("decode data presence: %w", err)
	}
	object := root
	path := "data"
	if objectKey != "" {
		value, ok := root[objectKey]
		if !ok {
			return fmt.Errorf("data.%s is required", objectKey)
		}
		if err := json.Unmarshal(value, &object); err != nil {
			return fmt.Errorf("data.%s must be an object", objectKey)
		}
		path += "." + objectKey
	}
	for _, field := range fields {
		if _, ok := object[field]; !ok {
			return fmt.Errorf("%s.%s is required", path, field)
		}
	}
	return nil
}

func isOneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}
