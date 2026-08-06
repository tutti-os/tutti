package sessionreplay

import (
	"encoding/json"
	"fmt"
	"strings"
)

// normalizeReplayAgentTargetRewrites validates the runtime-only target
// aliases supplied by a replay runner. The cassette keeps its recorded target
// identity; the semantic runtime uses these aliases when materializing the
// same cassette against a runtime-specific target (for example a shared Agent
// binding created for the current device).
func normalizeReplayAgentTargetRewrites(
	rewrites map[string]string,
) (map[string]string, error) {
	if len(rewrites) == 0 {
		return nil, nil
	}
	normalized := make(map[string]string, len(rewrites))
	for recorded, runtime := range rewrites {
		recorded = strings.TrimSpace(recorded)
		runtime = strings.TrimSpace(runtime)
		if recorded == "" || runtime == "" {
			return nil, fmt.Errorf(
				"replay Agent target rewrite requires recorded and runtime target IDs",
			)
		}
		normalized[recorded] = runtime
	}
	return normalized, nil
}

// rewriteReplayAgentTargetFields applies target aliases to every JSON field
// named agentTargetId. Replay state contains this identity both on canonical
// Sessions and in nested message/effect payloads, so rewriting only the root
// Session would leave semantic comparison inconsistent.
func rewriteReplayAgentTargetFields[T any](value T, rewrites map[string]string) (T, error) {
	if len(rewrites) == 0 {
		return value, nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		var zero T
		return zero, fmt.Errorf("encode replay Agent target rewrite: %w", err)
	}
	var document any
	if err := json.Unmarshal(raw, &document); err != nil {
		var zero T
		return zero, fmt.Errorf("decode replay Agent target rewrite: %w", err)
	}
	rewriteReplayAgentTargetFieldsInValue(document, rewrites)
	rewritten, err := json.Marshal(document)
	if err != nil {
		var zero T
		return zero, fmt.Errorf("encode rewritten replay Agent target: %w", err)
	}
	var result T
	if err := json.Unmarshal(rewritten, &result); err != nil {
		var zero T
		return zero, fmt.Errorf("decode rewritten replay Agent target: %w", err)
	}
	return result, nil
}

func rewriteReplayAgentTargetFieldsInValue(value any, rewrites map[string]string) {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if key == "agentTargetId" {
				if recorded, ok := child.(string); ok {
					if runtime, exists := rewrites[strings.TrimSpace(recorded)]; exists {
						typed[key] = runtime
						continue
					}
				}
			}
			rewriteReplayAgentTargetFieldsInValue(child, rewrites)
		}
	case []any:
		for _, child := range typed {
			rewriteReplayAgentTargetFieldsInValue(child, rewrites)
		}
	}
}
