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

	"github.com/tutti-os/tutti/packages/agent/daemon/httpx"
	controlplanehttp "github.com/tutti-os/tutti/packages/agent/daemon/internal/httpclient"
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
	// Metadata resolution: explicit input fields win, then the source, then
	// (for the state document) the state itself. Existing non-empty values
	// are left byte-identical in place; resolution only fills empty slots, so
	// callers that carry no metadata anywhere produce an unchanged request.
	agentTargetID := firstNonEmptyString(input.AgentTargetID, input.Source.AgentTargetID, input.State.AgentTargetID)
	deviceID := firstNonEmptyString(input.DeviceID, input.Source.DeviceID, input.State.DeviceID)
	source := input.Source
	if agentTargetID != "" && strings.TrimSpace(source.AgentTargetID) == "" {
		source.AgentTargetID = agentTargetID
	}
	if deviceID != "" && strings.TrimSpace(source.DeviceID) == "" {
		source.DeviceID = deviceID
	}
	state := sanitizeSessionStateUpdateForUpstream(input.State)
	if agentTargetID != "" && strings.TrimSpace(state.AgentTargetID) == "" {
		state.AgentTargetID = agentTargetID
	}
	if deviceID != "" && strings.TrimSpace(state.DeviceID) == "" {
		state.DeviceID = deviceID
	}
	requestBody, err := marshalRequestBody(reportSessionStateRequest{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		AgentTargetID:  agentTargetID,
		DeviceID:       deviceID,
		SessionOrigin:  sessionOriginCanonicalRequestValue(input.SessionOrigin),
		Connector:      input.Connector,
		Source:         &source,
		State:          state,
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
	// Metadata resolution mirrors ReportSessionState: explicit input fields
	// win, then the source; only empty slots are filled.
	agentTargetID := firstNonEmptyString(input.AgentTargetID, input.Source.AgentTargetID)
	deviceID := firstNonEmptyString(input.DeviceID, input.Source.DeviceID)
	source := input.Source
	if agentTargetID != "" && strings.TrimSpace(source.AgentTargetID) == "" {
		source.AgentTargetID = agentTargetID
	}
	if deviceID != "" && strings.TrimSpace(source.DeviceID) == "" {
		source.DeviceID = deviceID
	}
	requestBatches, err := marshalReportSessionMessagesRequestsForUpload(reportSessionMessagesRequest{
		WorkspaceID:   workspaceID,
		AgentTargetID: agentTargetID,
		DeviceID:      deviceID,
		SessionOrigin: sessionOriginCanonicalRequestValue(input.SessionOrigin),
		Connector:     input.Connector,
		Source:        &source,
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
	if deviceID := strings.TrimSpace(input.DeviceID); deviceID != "" {
		query.Set("device_id", deviceID)
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
	if deviceID := strings.TrimSpace(input.DeviceID); deviceID != "" {
		query.Set("device_id", deviceID)
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

// SanitizeTimelineItemsForRelay reuses the upstream payload sanitation rules for
// local relay transports so oversized tool outputs do not block activity reporting.

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
	AgentTargetID  string                           `json:"agentTargetId,omitempty"`
	DeviceID       string                           `json:"deviceId,omitempty"`
	SessionOrigin  string                           `json:"sessionOrigin,omitempty"`
	Source         *EventSource                     `json:"source,omitempty"`
	Connector      *ConnectorInfo                   `json:"connector,omitempty"`
	State          WorkspaceAgentSessionStateUpdate `json:"state,omitempty"`
}

type reportSessionMessagesRequest struct {
	WorkspaceID   string                               `json:"roomId,omitempty"`
	AgentTargetID string                               `json:"agentTargetId,omitempty"`
	DeviceID      string                               `json:"deviceId,omitempty"`
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
