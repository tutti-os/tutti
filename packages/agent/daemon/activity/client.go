//revive:disable:file-length-limit
//nolint:unused // Retain migrated helpers until the next agent-daemon decomposition pass.
package agentsessionstore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agentactivity/daemon/httpx"
	controlplanehttp "github.com/tutti-os/tutti/packages/agentactivity/daemon/internal/httpclient"
)

func NewClient(cfg Config) *Client {
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = httpx.NewClient(defaultTimeout)
	}
	return &Client{
		cfg:        cfg,
		httpClient: httpClient,
	}
}

func (c *Client) ReportActivity(ctx context.Context, input ReportActivityInput) (ReportActivityReply, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	if workspaceID == "" {
		return ReportActivityReply{}, errors.New("workspace id is required")
	}
	return ReportActivityAsSessionUpdates(ctx, c, input)
}

func (c *Client) ReportSessionState(ctx context.Context, input ReportSessionStateInput) (ReportSessionStateReply, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	if workspaceID == "" {
		return ReportSessionStateReply{}, errors.New("workspace id is required")
	}
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if agentSessionID == "" {
		return ReportSessionStateReply{}, errors.New("agent session id is required")
	}
	endpoint := fmt.Sprintf(
		"%s/rooms/%s/agents/sessions/%s/state",
		resolveSessionAPIPrefix(c.cfg.BaseURL),
		url.PathEscape(workspaceID),
		url.PathEscape(agentSessionID),
	)
	requestBody, err := marshalRequestBody(reportSessionStateRequest{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		SessionOrigin:  sessionOriginCanonicalRequestValue(input.SessionOrigin),
		Connector:      input.Connector,
		Source:         &input.Source,
		State:          sanitizeSessionStateUpdateForUpstream(input.State),
	})
	if err != nil {
		return ReportSessionStateReply{}, fmt.Errorf("prepare agent session state request: %w", err)
	}
	var reply ReportSessionStateReply
	reply.RequestBodyBytes = len(requestBody)
	if err := c.postJSONWithTransientRemoteRetry(ctx, endpoint, requestBody, &reply); err != nil {
		return reply, WithRequestBodyBytes(err, reply.RequestBodyBytes)
	}
	reply.RequestBodyBytes = len(requestBody)
	return reply, nil
}

func (c *Client) ReportSessionMessages(ctx context.Context, input ReportSessionMessagesInput) (ReportSessionMessagesReply, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	if workspaceID == "" {
		return ReportSessionMessagesReply{}, errors.New("workspace id is required")
	}
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if agentSessionID == "" {
		return ReportSessionMessagesReply{}, errors.New("agent session id is required")
	}
	endpoint := fmt.Sprintf(
		"%s/rooms/%s/agents/sessions/%s/messages",
		resolveSessionAPIPrefix(c.cfg.BaseURL),
		url.PathEscape(workspaceID),
		url.PathEscape(agentSessionID),
	)
	requestBatches, err := marshalReportSessionMessagesRequestsForUpload(reportSessionMessagesRequest{
		WorkspaceID:   workspaceID,
		SessionOrigin: sessionOriginCanonicalRequestValue(input.SessionOrigin),
		Connector:     input.Connector,
		Source:        &input.Source,
		Updates:       sanitizeSessionMessageUpdatesForUpstream(input.Updates),
	})
	if err != nil {
		return ReportSessionMessagesReply{}, fmt.Errorf("prepare agent session messages request: %w", err)
	}
	var reply ReportSessionMessagesReply
	for _, batch := range requestBatches {
		reply.RequestBodyBytes += len(batch)
		var batchReply ReportSessionMessagesReply
		err = c.postJSONWithTransientRemoteRetry(ctx, endpoint, batch, &batchReply)
		if err != nil {
			return reply, WithRequestBodyBytes(err, len(batch))
		}
		reply.AcceptedCount += batchReply.AcceptedCount
		if batchReply.LatestVersion > reply.LatestVersion {
			reply.LatestVersion = batchReply.LatestVersion
		}
	}
	return reply, nil
}

func (c *Client) ReportActivityJSON(ctx context.Context, workspaceID string, payload json.RawMessage) (ReportActivityReply, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return ReportActivityReply{}, errors.New("workspace id is required")
	}
	input, err := DecodeReportActivityJSON(payload)
	if err != nil {
		return ReportActivityReply{}, fmt.Errorf("decode agent activity request: %w", err)
	}
	input.WorkspaceID = workspaceID
	return ReportActivityAsSessionUpdates(ctx, c, input)
}

func DecodeReportActivityJSON(payload json.RawMessage) (ReportActivityInput, error) {
	var request reportActivityRequest
	if err := json.Unmarshal(payload, &request); err != nil {
		return ReportActivityInput{}, err
	}
	input := ReportActivityInput{
		TimelineItems:  request.TimelineItems,
		StatePatches:   request.StatePatches,
		MessageUpdates: request.MessageUpdates,
	}
	if request.Connector != nil {
		connector := *request.Connector
		input.Connector = &connector
	}
	if request.Source != nil {
		input.Source = *request.Source
	}
	return input, nil
}

func (c *Client) ListAgents(ctx context.Context, workspaceID string) (*WorkspaceAgentSnapshot, error) {
	return c.ListAgentsWithOrigin(ctx, workspaceID, "")
}

func (c *Client) ListAgentsWithOrigin(ctx context.Context, workspaceID string, sessionOrigin string) (*WorkspaceAgentSnapshot, error) {
	return c.ListAgentsWithFilter(ctx, ListAgentsInput{
		WorkspaceID:   workspaceID,
		SessionOrigin: sessionOrigin,
	})
}

func (c *Client) ListAgentsWithFilter(ctx context.Context, input ListAgentsInput) (*WorkspaceAgentSnapshot, error) {
	var snapshot WorkspaceAgentSnapshot
	endpoint := fmt.Sprintf(
		"%s/rooms/%s/agents/list",
		resolveAPIPrefix(c.cfg.BaseURL),
		url.PathEscape(input.WorkspaceID),
	)
	query := url.Values{}
	if origin := sessionOriginCanonicalQueryValue(input.SessionOrigin); origin != "" {
		query.Set("session_origin", origin)
	}
	if userID := strings.TrimSpace(input.UserID); userID != "" {
		query.Set("user_id", userID)
	}
	if encoded := query.Encode(); encoded != "" {
		endpoint += "?" + encoded
	}
	err := c.doJSONWithTransientRemoteRetry(ctx, http.MethodGet, endpoint, nil, &snapshot)
	if err != nil {
		return nil, err
	}
	return &snapshot, nil
}

type DeleteAgentSessionInput struct {
	WorkspaceID    string
	AgentSessionID string
	SessionOrigin  string
}

func (c *Client) DeleteAgentSession(ctx context.Context, input DeleteAgentSessionInput) error {
	query := url.Values{}
	if origin := sessionOriginCanonicalQueryValue(input.SessionOrigin); origin != "" {
		query.Set("session_origin", origin)
	}
	endpoint := fmt.Sprintf(
		"%s/rooms/%s/agents/%s",
		resolveAPIPrefix(c.cfg.BaseURL),
		url.PathEscape(input.WorkspaceID),
		url.PathEscape(input.AgentSessionID),
	)
	if encoded := query.Encode(); encoded != "" {
		endpoint += "?" + encoded
	}
	return c.doJSON(ctx, http.MethodDelete, endpoint, nil, nil)
}

func (c *Client) ListSessionMessages(ctx context.Context, input ListSessionMessagesInput) (*ListSessionMessagesReply, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	if workspaceID == "" {
		return nil, errors.New("workspace id is required")
	}
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if agentSessionID == "" {
		return nil, errors.New("agent session id is required")
	}
	query := url.Values{}
	if input.AfterVersion > 0 {
		query.Set("after_version", strconv.FormatUint(input.AfterVersion, 10))
	}
	if input.Limit > 0 {
		query.Set("limit", strconv.Itoa(input.Limit))
	}
	if origin := sessionOriginCanonicalQueryValue(input.SessionOrigin); origin != "" {
		query.Set("session_origin", origin)
	}

	endpoint := fmt.Sprintf(
		"%s/rooms/%s/agents/sessions/%s/messages",
		resolveSessionAPIPrefix(c.cfg.BaseURL),
		url.PathEscape(workspaceID),
		url.PathEscape(agentSessionID),
	)
	if encoded := query.Encode(); encoded != "" {
		endpoint += "?" + encoded
	}

	var messages ListSessionMessagesReply
	if err := c.doJSONWithTransientRemoteRetry(ctx, http.MethodGet, endpoint, nil, &messages); err != nil {
		return nil, err
	}
	return &messages, nil
}

func (c *Client) postJSON(ctx context.Context, endpoint string, requestBody any, responseBody any) error {
	return c.doJSON(ctx, http.MethodPost, endpoint, requestBody, responseBody)
}

func (c *Client) postJSONWithTransientRemoteRetry(
	ctx context.Context,
	endpoint string,
	requestBody any,
	responseBody any,
) error {
	var err error
	for attempt := 0; ; attempt++ {
		err = c.postJSON(ctx, endpoint, requestBody, responseBody)
		if err == nil || !shouldRetryTransientRemotePost(c.cfg.BaseURL, err) {
			return err
		}
		if attempt >= len(controlplanehttp.DefaultTransientBackoffs) || ctx.Err() != nil {
			return err
		}
		if waitErr := sleepWithContext(ctx, controlplanehttp.DefaultTransientBackoffs[attempt]); waitErr != nil {
			return err
		}
	}
}

func (c *Client) doJSONWithTransientRemoteRetry(
	ctx context.Context,
	method string,
	endpoint string,
	requestBody any,
	responseBody any,
) error {
	var err error
	for attempt := 0; ; attempt++ {
		err = c.doJSON(ctx, method, endpoint, requestBody, responseBody)
		if err == nil || !shouldRetryTransientRemoteRead(c.cfg.BaseURL, method, err) {
			return err
		}
		if attempt >= len(controlplanehttp.DefaultTransientBackoffs) || ctx.Err() != nil {
			return err
		}
		if waitErr := sleepWithContext(ctx, controlplanehttp.DefaultTransientBackoffs[attempt]); waitErr != nil {
			return err
		}
	}
}

func sessionOriginCanonicalQueryValue(origin string) string {
	return canonicalSessionOriginValue(origin)
}

func sessionOriginCanonicalRequestValue(origin string) string {
	return canonicalSessionOriginValue(origin)
}

func (c *Client) doJSON(ctx context.Context, method, endpoint string, requestBody any, responseBody any) error {
	baseURL := strings.TrimRight(strings.TrimSpace(c.cfg.BaseURL), "/")
	if baseURL == "" {
		return fmt.Errorf("agent activity base url is required")
	}

	var body io.Reader
	if requestBody != nil {
		raw, err := marshalRequestBody(requestBody)
		if err != nil {
			return fmt.Errorf("marshal agent activity request: %w", err)
		}
		body = bytes.NewReader(raw)
	}

	req, err := http.NewRequestWithContext(ctx, method, baseURL+endpoint, body)
	if err != nil {
		return err
	}
	c.setHeaders(req)

	res, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()

	raw, err := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return HTTPError{StatusCode: res.StatusCode, Body: strings.TrimSpace(string(raw)), Header: res.Header.Clone()}
	}
	if responseBody == nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, responseBody); err != nil {
		return fmt.Errorf("decode agent activity response: %w", err)
	}
	return nil
}

func marshalRequestBody(requestBody any) ([]byte, error) {
	switch value := requestBody.(type) {
	case json.RawMessage:
		return value, nil
	case []byte:
		return value, nil
	default:
		return json.Marshal(requestBody)
	}
}

func sanitizeReportActivityRequest(req reportActivityRequest) reportActivityRequest {
	req.TimelineItems = sanitizeTimelineItemsForUpstream(req.TimelineItems)
	req.StatePatches = sanitizeStatePatchesForUpstream(req.StatePatches)
	req.MessageUpdates = sanitizeMessageUpdatesForUpstream(req.MessageUpdates)
	return req
}

// SanitizeTimelineItemsForRelay reuses the upstream payload sanitation rules for
// local relay transports so oversized tool outputs do not block activity reporting.
func SanitizeTimelineItemsForRelay(items []WorkspaceAgentTimelineItem) []WorkspaceAgentTimelineItem {
	return sanitizeTimelineItemsForUpstream(items)
}

// SanitizeStatePatchesForRelay reuses the upstream payload sanitation rules for
// local relay transports so oversized tool outputs do not block activity reporting.
func SanitizeStatePatchesForRelay(patches []WorkspaceAgentStatePatch) []WorkspaceAgentStatePatch {
	return sanitizeStatePatchesForUpstream(patches)
}

func marshalReportActivityRequestsForUpload(req reportActivityRequest) ([][]byte, error) {
	requestBody, err := marshalRequestBody(req)
	if err != nil {
		return nil, err
	}
	if len(requestBody) <= maxUpstreamReportRequestBytes {
		return [][]byte{requestBody}, nil
	}

	base := reportActivityRequest{
		Connector: req.Connector,
		Source:    req.Source,
	}
	current := base
	currentBody, err := marshalRequestBody(current)
	if err != nil {
		return nil, err
	}
	requests := make([][]byte, 0, 2)
	flush := func() {
		if len(current.TimelineItems) == 0 && len(current.StatePatches) == 0 && len(current.MessageUpdates) == 0 {
			return
		}
		requests = append(requests, currentBody)
		current = base
		currentBody, _ = marshalRequestBody(current)
	}
	appendTimeline := func(item WorkspaceAgentTimelineItem) error {
		candidate := current
		candidate.TimelineItems = append(append([]WorkspaceAgentTimelineItem(nil), current.TimelineItems...), item)
		candidateBody, err := marshalRequestBody(candidate)
		if err != nil {
			return err
		}
		if len(candidateBody) <= maxUpstreamReportRequestBytes {
			current = candidate
			currentBody = candidateBody
			return nil
		}
		if len(current.TimelineItems) == 0 && len(current.StatePatches) == 0 && len(current.MessageUpdates) == 0 {
			return fmt.Errorf("timeline item %q exceeds upstream request size limit after sanitization", strings.TrimSpace(item.EventID))
		}
		flush()
		current = base
		current.TimelineItems = []WorkspaceAgentTimelineItem{item}
		currentBody, err = marshalRequestBody(current)
		if err != nil {
			return err
		}
		if len(currentBody) > maxUpstreamReportRequestBytes {
			return fmt.Errorf("timeline item %q exceeds upstream request size limit after sanitization", strings.TrimSpace(item.EventID))
		}
		return nil
	}
	appendStatePatch := func(patch WorkspaceAgentStatePatch) error {
		candidate := current
		candidate.StatePatches = append(append([]WorkspaceAgentStatePatch(nil), current.StatePatches...), patch)
		candidateBody, err := marshalRequestBody(candidate)
		if err != nil {
			return err
		}
		if len(candidateBody) <= maxUpstreamReportRequestBytes {
			current = candidate
			currentBody = candidateBody
			return nil
		}
		if len(current.TimelineItems) == 0 && len(current.StatePatches) == 0 && len(current.MessageUpdates) == 0 {
			return fmt.Errorf("state patch for session %q exceeds upstream request size limit after sanitization", strings.TrimSpace(patch.AgentSessionID))
		}
		flush()
		current = base
		current.StatePatches = []WorkspaceAgentStatePatch{patch}
		currentBody, err = marshalRequestBody(current)
		if err != nil {
			return err
		}
		if len(currentBody) > maxUpstreamReportRequestBytes {
			return fmt.Errorf("state patch for session %q exceeds upstream request size limit after sanitization", strings.TrimSpace(patch.AgentSessionID))
		}
		return nil
	}
	appendMessageUpdate := func(update WorkspaceAgentMessageUpdate) error {
		candidate := current
		candidate.MessageUpdates = append(append([]WorkspaceAgentMessageUpdate(nil), current.MessageUpdates...), update)
		candidateBody, err := marshalRequestBody(candidate)
		if err != nil {
			return err
		}
		if len(candidateBody) <= maxUpstreamReportRequestBytes {
			current = candidate
			currentBody = candidateBody
			return nil
		}
		if len(current.TimelineItems) == 0 && len(current.StatePatches) == 0 && len(current.MessageUpdates) == 0 {
			return fmt.Errorf("message update %q exceeds upstream request size limit after sanitization", strings.TrimSpace(update.MessageID))
		}
		flush()
		current = base
		current.MessageUpdates = []WorkspaceAgentMessageUpdate{update}
		currentBody, err = marshalRequestBody(current)
		if err != nil {
			return err
		}
		if len(currentBody) > maxUpstreamReportRequestBytes {
			return fmt.Errorf("message update %q exceeds upstream request size limit after sanitization", strings.TrimSpace(update.MessageID))
		}
		return nil
	}

	for _, item := range req.TimelineItems {
		if err := appendTimeline(item); err != nil {
			return nil, err
		}
	}
	for _, patch := range req.StatePatches {
		if err := appendStatePatch(patch); err != nil {
			return nil, err
		}
	}
	for _, update := range req.MessageUpdates {
		if err := appendMessageUpdate(update); err != nil {
			return nil, err
		}
	}
	flush()
	return requests, nil
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

func sanitizeMessageUpdatesForUpstream(updates []WorkspaceAgentMessageUpdate) []WorkspaceAgentMessageUpdate {
	if len(updates) == 0 {
		return updates
	}
	out := make([]WorkspaceAgentMessageUpdate, len(updates))
	for i, update := range updates {
		out[i] = update
		if len(update.Payload) == 0 {
			continue
		}
		out[i].Payload = sanitizeToolPayloadMap(clonePayloadMap(update.Payload))
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

func (c *Client) setHeaders(req *http.Request) {
	req.Header.Set("Accept", "application/json")
	if req.Body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie := strings.TrimSpace(c.cfg.SessionCookie); cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	if userID := strings.TrimSpace(c.cfg.UserID); userID != "" {
		req.Header.Set("X-User-Id", userID)
	}
	if token := strings.TrimSpace(c.cfg.Token); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if lane := strings.TrimSpace(c.cfg.PPELane); lane != "" {
		req.Header.Set("x-zk-ppe-lane", lane)
	}
}

func resolveAPIPrefix(baseURL string) string {
	if isLoopbackBaseURL(baseURL) {
		return localAPIPrefix
	}
	return remoteAPIPrefix
}

func resolveSessionAPIPrefix(baseURL string) string {
	if isLoopbackBaseURL(baseURL) {
		return localAPIPrefix
	}
	return remoteAPIPrefix
}

func shouldRetryTransientRemotePost(baseURL string, err error) bool {
	if err == nil || resolveAPIPrefix(baseURL) != remoteAPIPrefix {
		return false
	}
	return controlplanehttp.IsTransientNetworkError(err)
}

func shouldRetryTransientRemoteRead(baseURL string, method string, err error) bool {
	if err == nil || resolveAPIPrefix(baseURL) != remoteAPIPrefix {
		return false
	}
	if method != http.MethodGet {
		return false
	}
	return controlplanehttp.IsTransientNetworkError(err)
}

func sleepWithContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func isLoopbackBaseURL(raw string) bool {
	host := baseURLHostname(raw)
	if host == "" {
		return false
	}
	if strings.EqualFold(host, "localhost") || host == "0.0.0.0" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func baseURLHostname(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err == nil && parsed.Hostname() != "" {
		return strings.TrimSpace(parsed.Hostname())
	}
	if strings.Contains(raw, "://") {
		return ""
	}
	parsed, err = url.Parse("http://" + raw)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(parsed.Hostname())
}

type reportActivityRequest struct {
	Connector      *ConnectorInfo                `json:"connector,omitempty"`
	Source         *EventSource                  `json:"source,omitempty"`
	TimelineItems  []WorkspaceAgentTimelineItem  `json:"timelineItems,omitempty"`
	StatePatches   []WorkspaceAgentStatePatch    `json:"statePatches,omitempty"`
	MessageUpdates []WorkspaceAgentMessageUpdate `json:"messageUpdates,omitempty"`
}

type reportSessionStateRequest struct {
	WorkspaceID    string                           `json:"roomId,omitempty"`
	AgentSessionID string                           `json:"agentSessionId,omitempty"`
	SessionOrigin  string                           `json:"sessionOrigin,omitempty"`
	Source         *EventSource                     `json:"source,omitempty"`
	Connector      *ConnectorInfo                   `json:"connector,omitempty"`
	State          WorkspaceAgentSessionStateUpdate `json:"state,omitempty"`
}

type reportSessionMessagesRequest struct {
	WorkspaceID   string                               `json:"roomId,omitempty"`
	SessionOrigin string                               `json:"sessionOrigin,omitempty"`
	Source        *EventSource                         `json:"source,omitempty"`
	Connector     *ConnectorInfo                       `json:"connector,omitempty"`
	Updates       []WorkspaceAgentSessionMessageUpdate `json:"updates,omitempty"`
}

type flexibleUint64 uint64

func (v *flexibleUint64) UnmarshalJSON(data []byte) error {
	parsed, err := parseFlexibleUint64(data)
	if err != nil {
		return err
	}
	*v = flexibleUint64(parsed)
	return nil
}

type flexibleInt64 int64

func (v *flexibleInt64) UnmarshalJSON(data []byte) error {
	parsed, err := parseFlexibleInt64(data)
	if err != nil {
		return err
	}
	*v = flexibleInt64(parsed)
	return nil
}

func parseFlexibleUint64(data []byte) (uint64, error) {
	text := strings.TrimSpace(string(data))
	if text == "" || text == "null" {
		return 0, nil
	}
	if strings.HasPrefix(text, `"`) {
		var value string
		if err := json.Unmarshal(data, &value); err != nil {
			return 0, err
		}
		text = strings.TrimSpace(value)
		if text == "" {
			return 0, nil
		}
	}
	return strconv.ParseUint(text, 10, 64)
}

func parseFlexibleInt64(data []byte) (int64, error) {
	text := strings.TrimSpace(string(data))
	if text == "" || text == "null" {
		return 0, nil
	}
	if strings.HasPrefix(text, `"`) {
		var value string
		if err := json.Unmarshal(data, &value); err != nil {
			return 0, err
		}
		text = strings.TrimSpace(value)
		if text == "" {
			return 0, nil
		}
	}
	return strconv.ParseInt(text, 10, 64)
}
