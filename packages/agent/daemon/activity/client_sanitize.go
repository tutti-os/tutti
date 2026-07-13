package agentsessionstore

import (
	"encoding/json"
	"fmt"
	"strings"
)

func SanitizeTimelineItemsForRelay(items []WorkspaceAgentTimelineItem) []WorkspaceAgentTimelineItem {
	return sanitizeTimelineItemsForUpstream(items)
}

// SanitizeStatePatchesForRelay reuses the upstream payload sanitation rules for
// local relay transports so oversized tool outputs do not block activity reporting.
func SanitizeStatePatchesForRelay(patches []WorkspaceAgentStatePatch) []WorkspaceAgentStatePatch {
	return sanitizeStatePatchesForUpstream(patches)
}

func marshalReportSessionMessagesRequestsForUpload(req reportSessionMessagesRequest) ([][]byte, error) {
	requestBody, err := marshalRequestBody(req)
	if err != nil {
		return nil, err
	}
	if len(requestBody) <= maxUpstreamReportRequestBytes {
		return [][]byte{requestBody}, nil
	}

	base := reportSessionMessagesRequest{
		WorkspaceID:   req.WorkspaceID,
		AgentTargetID: req.AgentTargetID,
		DeviceID:      req.DeviceID,
		SessionOrigin: req.SessionOrigin,
		Connector:     req.Connector,
		Source:        req.Source,
	}
	current := base
	currentBody, err := marshalRequestBody(current)
	if err != nil {
		return nil, err
	}
	requests := make([][]byte, 0, 2)
	flush := func() {
		if len(current.Updates) == 0 {
			return
		}
		requests = append(requests, currentBody)
		current = base
		currentBody, _ = marshalRequestBody(current)
	}
	appendMessageUpdate := func(update WorkspaceAgentSessionMessageUpdate) error {
		candidate := current
		candidate.Updates = append(append([]WorkspaceAgentSessionMessageUpdate(nil), current.Updates...), update)
		candidateBody, err := marshalRequestBody(candidate)
		if err != nil {
			return err
		}
		if len(candidateBody) <= maxUpstreamReportRequestBytes {
			current = candidate
			currentBody = candidateBody
			return nil
		}
		if len(current.Updates) == 0 {
			return fmt.Errorf("message update %q exceeds upstream request size limit after sanitization", strings.TrimSpace(update.MessageID))
		}
		flush()
		current = base
		current.Updates = []WorkspaceAgentSessionMessageUpdate{update}
		currentBody, err = marshalRequestBody(current)
		if err != nil {
			return err
		}
		if len(currentBody) > maxUpstreamReportRequestBytes {
			return fmt.Errorf("message update %q exceeds upstream request size limit after sanitization", strings.TrimSpace(update.MessageID))
		}
		return nil
	}

	for _, update := range req.Updates {
		if err := appendMessageUpdate(update); err != nil {
			return nil, err
		}
	}
	flush()
	return requests, nil
}

func sanitizeSessionStateUpdateForUpstream(update WorkspaceAgentSessionStateUpdate) WorkspaceAgentSessionStateUpdate {
	if update.Turn != nil && len(update.Turn.FileChanges) > 0 {
		turn := *update.Turn
		turn.FileChanges = sanitizeToolPayloadMap(clonePayloadMap(update.Turn.FileChanges))
		update.Turn = &turn
	}
	return update
}

func sanitizeSessionMessageUpdatesForUpstream(updates []WorkspaceAgentSessionMessageUpdate) []WorkspaceAgentSessionMessageUpdate {
	if len(updates) == 0 {
		return updates
	}
	out := make([]WorkspaceAgentSessionMessageUpdate, len(updates))
	for i, update := range updates {
		out[i] = update
		if len(update.Payload) == 0 {
			continue
		}
		out[i].Payload = sanitizeSessionMessagePayloadForUpstream(update.Kind, update.Payload)
	}
	return out
}

func sanitizeSessionMessagePayloadForUpstream(kind string, payload map[string]any) map[string]any {
	if isTextualSessionMessageKind(kind) {
		return sanitizeTextSessionMessagePayloadForUpstream(payload)
	}
	sanitized := sanitizeToolPayloadMap(clonePayloadMap(payload))
	if len(sanitized) == 0 {
		return sanitized
	}
	body, err := json.Marshal(sanitized)
	if err != nil || len(body) <= maxUpstreamSessionMessagePayloadBytes {
		return sanitized
	}
	return compactOversizedSessionMessagePayload(sanitized, len(body))
}

func isTextualSessionMessageKind(kind string) bool {
	switch strings.TrimSpace(strings.ToLower(kind)) {
	case "text", "reasoning":
		return true
	default:
		return false
	}
}

func sanitizeTextSessionMessagePayloadForUpstream(payload map[string]any) map[string]any {
	if len(payload) == 0 {
		return payload
	}
	out := make(map[string]any, len(payload))
	for key, value := range payload {
		if isTextSessionMessageContentKey(key) {
			out[key] = value
			continue
		}
		out[key] = sanitizeToolPayloadField(key, value)
	}
	return out
}

func isTextSessionMessageContentKey(key string) bool {
	switch strings.TrimSpace(strings.ToLower(key)) {
	case "content", "text", "message", "body":
		return true
	default:
		return false
	}
}

func compactOversizedSessionMessagePayload(payload map[string]any, originalBytes int) map[string]any {
	out := make(map[string]any)
	for _, key := range []string{
		"callId",
		"callID",
		"call_id",
		"parentCallId",
		"parent_call_id",
		"rootCallId",
		"root_call_id",
		"toolName",
		"name",
		"kind",
		"status",
		"title",
		"type",
		"contentMode",
		"text",
	} {
		if value, ok := compactSessionMessagePayloadValue(payload[key]); ok {
			out[key] = value
		}
	}
	out["truncatedPayload"] = fmt.Sprintf("[truncated payload; %d bytes]", originalBytes)
	out["truncatedPayloadBytes"] = originalBytes
	return out
}

func compactSessionMessagePayloadValue(value any) (any, bool) {
	switch typed := value.(type) {
	case string:
		if strings.TrimSpace(typed) == "" {
			return nil, false
		}
		return sanitizeToolPayloadString(typed), true
	case bool:
		return typed, true
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return typed, true
	default:
		return nil, false
	}
}

func sanitizeTimelineItemsForUpstream(items []WorkspaceAgentTimelineItem) []WorkspaceAgentTimelineItem {
	if len(items) == 0 {
		return items
	}
	out := make([]WorkspaceAgentTimelineItem, len(items))
	for i, item := range items {
		out[i] = item
		if len(item.Payload) == 0 {
			continue
		}
		out[i].Payload = sanitizeToolPayloadMap(clonePayloadMap(item.Payload))
	}
	return out
}

func sanitizeStatePatchesForUpstream(patches []WorkspaceAgentStatePatch) []WorkspaceAgentStatePatch {
	if len(patches) == 0 {
		return patches
	}
	out := make([]WorkspaceAgentStatePatch, len(patches))
	for i, patch := range patches {
		out[i] = patch
		if len(patch.Entities) == 0 {
			continue
		}
		out[i].Entities = make([]WorkspaceAgentEntityPatch, len(patch.Entities))
		for j, entity := range patch.Entities {
			out[i].Entities[j] = entity
			out[i].Entities[j].Input = sanitizeToolPayloadMap(entity.Input)
			out[i].Entities[j].Output = sanitizeToolPayloadMap(entity.Output)
			out[i].Entities[j].Error = sanitizeToolPayloadMap(entity.Error)
		}
	}
	return out
}

func sanitizeToolPayloadMap(payload map[string]any) map[string]any {
	if len(payload) == 0 {
		return payload
	}
	if sanitized, ok := sanitizeStructuredBinaryPayloadMap(payload); ok {
		return sanitized
	}
	out := make(map[string]any, len(payload))
	for key, value := range payload {
		out[key] = sanitizeToolPayloadField(key, value)
	}
	return out
}

func sanitizeStructuredBinaryPayloadMap(payload map[string]any) (map[string]any, bool) {
	data, ok := payload["data"].(string)
	if !ok || data == "" {
		return nil, false
	}
	payloadType, _ := payload["type"].(string)
	mimeType, _ := payload["mimeType"].(string)
	if strings.TrimSpace(payloadType) != "image" && strings.TrimSpace(mimeType) == "" {
		return nil, false
	}
	out := make(map[string]any, len(payload))
	for key, value := range payload {
		if key == "data" {
			out[key] = summarizeBinaryPayloadString(strings.TrimSpace(payloadType), strings.TrimSpace(mimeType), data)
			continue
		}
		out[key] = sanitizeToolPayloadField(key, value)
	}
	return out, true
}

func sanitizeToolPayloadField(key string, value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return sanitizeToolPayloadMap(typed)
	case []any:
		if len(typed) == 0 {
			return []any{}
		}
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = sanitizeToolPayloadValue(item)
		}
		return out
	case string:
		return sanitizeToolPayloadStringForKey(key, typed)
	default:
		return value
	}
}

func sanitizeToolPayloadValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return sanitizeToolPayloadMap(typed)
	case []any:
		if len(typed) == 0 {
			return []any{}
		}
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = sanitizeToolPayloadValue(item)
		}
		return out
	case string:
		return sanitizeToolPayloadString(typed)
	default:
		return value
	}
}

func sanitizeToolPayloadStringForKey(key string, value string) string {
	if looksLikeRawBinaryField(key, value) {
		return summarizeBinaryPayloadString("", "", value)
	}
	return sanitizeToolPayloadString(value)
}

func sanitizeToolPayloadString(value string) string {
	if len(value) == 0 {
		return value
	}
	if mediaType, ok := dataURLMediaType(value); ok {
		return summarizeBinaryPayloadString("image", mediaType, value)
	}
	if len(value) <= maxUpstreamToolPayloadStringBytes {
		return value
	}
	return value[:maxUpstreamToolPayloadStringBytes] +
		fmt.Sprintf("...[truncated %d bytes]", len(value)-maxUpstreamToolPayloadStringBytes)
}

func looksLikeRawBinaryField(key string, value string) bool {
	if len(value) <= maxUpstreamToolPayloadStringBytes {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "data", "base64", "bytes", "image", "image_data":
		return true
	default:
		return false
	}
}

func summarizeBinaryPayloadString(payloadType string, mimeType string, value string) string {
	label := strings.TrimSpace(mimeType)
	if label == "" {
		label = strings.TrimSpace(payloadType)
	}
	if label == "" {
		label = "binary"
	}
	return fmt.Sprintf("[omitted %s bytes; %d bytes]", label, len(value))
}

func dataURLMediaType(value string) (string, bool) {
	if !strings.HasPrefix(value, "data:") {
		return "", false
	}
	comma := strings.IndexByte(value, ',')
	if comma <= len("data:") {
		return "", false
	}
	meta := value[len("data:"):comma]
	semi := strings.IndexByte(meta, ';')
	if semi >= 0 {
		meta = meta[:semi]
	}
	mediaType := strings.TrimSpace(meta)
	if mediaType == "" {
		mediaType = "data"
	}
	return mediaType, true
}
