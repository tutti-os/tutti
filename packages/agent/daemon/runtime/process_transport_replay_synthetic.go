package agentruntime

import (
	"encoding/json"
)

func (c *replayProcessConnection) isOptionalProbeOutboundLocked(data []byte) bool {
	method, _, ok := processCassetteJSONRPCRequestBytes(data)
	return ok && c.descriptor.IsOptionalProbeMethod(method)
}

func (c *replayProcessConnection) absorbOptionalProbeOutboundLocked(data []byte) bool {
	if !c.isOptionalProbeOutboundLocked(data) {
		return false
	}
	method, _, ok := processCassetteJSONRPCRequestBytes(data)
	if !ok {
		return true
	}
	result := map[string]any{}
	if method == "thread/goal/get" {
		result = map[string]any{"goal": nil}
	}
	c.queueSyntheticJSONRPCResultLocked(data, result)
	c.signalChangedLocked()
	return true
}

// maybeSynthesizeImmediateStartupMetadataLocked covers best-effort startup RPCs
// whose taped responses sit after a checkpoint fence (for example rateLimits
// after turn/started). Matching the outbound still advances the cursor, but the
// client must not wait on a gated response.
func (c *replayProcessConnection) maybeSynthesizeImmediateStartupMetadataLocked(
	expected []byte,
	data []byte,
) {
	method, _, ok := processCassetteJSONRPCRequestBytes(data)
	if !ok {
		return
	}
	switch method {
	case "account/rateLimits/read":
		c.queueSyntheticJSONRPCResultLocked(data, map[string]any{
			"rateLimits": map[string]any{},
		})
	case "thread/goal/get":
		c.queueSyntheticJSONRPCResultLocked(data, map[string]any{"goal": nil})
	default:
		return
	}
	if _, recordedID, ok := processCassetteJSONRPCRequestBytes(expected); ok && recordedID != "" {
		c.skippedRPCs[recordedID] = struct{}{}
	}
}

func (c *replayProcessConnection) queueSyntheticJSONRPCResultLocked(
	data []byte,
	result map[string]any,
) {
	_, responseID, ok := processCassetteJSONRPCRequestBytes(data)
	if !ok || responseID == "" {
		return
	}
	values, decoded := decodeProcessCassetteJSONValues(data)
	if !decoded || len(values) != 1 {
		return
	}
	request, ok := values[0].(map[string]any)
	if !ok {
		return
	}
	payload, err := json.Marshal(map[string]any{
		"id":     request["id"],
		"result": result,
	})
	if err != nil {
		return
	}
	c.pendingSyntheticStdout = append(
		c.pendingSyntheticStdout,
		append(payload, '\n'),
	)
}

func (c *replayProcessConnection) HasPendingSyntheticStdout() bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.pendingSyntheticStdout) > 0
}
