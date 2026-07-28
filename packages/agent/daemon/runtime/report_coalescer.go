package agentruntime

import (
	"strings"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
)

type streamingReportCoalescer struct {
	window  time.Duration
	timer   *time.Timer
	timerCh <-chan time.Time
	pending map[string]*streamingReportBatch
	order   []string
}

type streamingReportBatch struct {
	indexByMessageKey map[string]int
	request           reportRequest
}

func newStreamingReportCoalescer(window time.Duration) *streamingReportCoalescer {
	if window <= 0 {
		window = defaultStreamingReportCoalesceWindow
	}
	return &streamingReportCoalescer{
		window:  window,
		pending: make(map[string]*streamingReportBatch),
	}
}

func (c *streamingReportCoalescer) add(request reportRequest) []reportRequest {
	if c == nil {
		return []reportRequest{request}
	}
	sessionKey := reportCoalesceSessionKey(request.report)
	if !request.submitProvenance && request.done == nil && isCoalescibleStreamingReport(request.report) {
		c.merge(sessionKey, request)
		c.ensureTimer()
		return nil
	}
	flushed := c.flushSession(sessionKey)
	flushed = append(flushed, request)
	if len(c.pending) == 0 {
		c.stopTimer()
	}
	return flushed
}

func (c *streamingReportCoalescer) ready() <-chan time.Time {
	if c == nil {
		return nil
	}
	return c.timerCh
}

func (c *streamingReportCoalescer) flushAll() []reportRequest {
	if c == nil || len(c.pending) == 0 {
		return nil
	}
	out := make([]reportRequest, 0, len(c.pending))
	for _, key := range c.order {
		batch, ok := c.pending[key]
		if !ok {
			continue
		}
		out = append(out, batch.request)
	}
	c.pending = make(map[string]*streamingReportBatch)
	c.order = nil
	c.stopTimer()
	return out
}

func (c *streamingReportCoalescer) stop() {
	if c == nil {
		return
	}
	c.stopTimer()
}

func (c *streamingReportCoalescer) merge(sessionKey string, request reportRequest) {
	if sessionKey == "" {
		sessionKey = reportCoalesceFallbackSessionKey(request.report)
	}
	batch := c.pending[sessionKey]
	if batch == nil {
		batchedRequest := request
		batchedRequest.report.MessageUpdates = nil
		batch = &streamingReportBatch{
			indexByMessageKey: make(map[string]int),
			request:           batchedRequest,
		}
		c.pending[sessionKey] = batch
		c.order = append(c.order, sessionKey)
	}
	batch.request.ctx = request.ctx
	for _, update := range request.report.MessageUpdates {
		messageKey := reportMessageUpdateCoalesceKey(request.report, update)
		if index, ok := batch.indexByMessageKey[messageKey]; ok {
			batch.request.report.MessageUpdates[index] = latestMessageUpdate(
				batch.request.report.MessageUpdates[index],
				update,
			)
			continue
		}
		batch.indexByMessageKey[messageKey] = len(batch.request.report.MessageUpdates)
		batch.request.report.MessageUpdates = append(batch.request.report.MessageUpdates, update)
	}
}

func (c *streamingReportCoalescer) flushSession(sessionKey string) []reportRequest {
	if c == nil || sessionKey == "" {
		return nil
	}
	batch := c.pending[sessionKey]
	if batch == nil {
		return nil
	}
	delete(c.pending, sessionKey)
	nextOrder := c.order[:0]
	for _, key := range c.order {
		if key != sessionKey {
			nextOrder = append(nextOrder, key)
		}
	}
	c.order = nextOrder
	return []reportRequest{batch.request}
}

func (c *streamingReportCoalescer) ensureTimer() {
	if c.timer != nil {
		return
	}
	c.timer = time.NewTimer(c.window)
	c.timerCh = c.timer.C
}

func (c *streamingReportCoalescer) stopTimer() {
	if c.timer == nil {
		return
	}
	if !c.timer.Stop() {
		select {
		case <-c.timer.C:
		default:
		}
	}
	c.timer = nil
	c.timerCh = nil
}

func isCoalescibleStreamingReport(report agentsessionstore.ReportActivityInput) bool {
	if len(report.TimelineItems) > 0 || len(report.StatePatches) > 0 || len(report.SessionAudits) > 0 || len(report.GoalReconcileRequests) > 0 || len(report.MessageUpdates) == 0 {
		return false
	}
	for _, update := range report.MessageUpdates {
		if !isCoalescibleStreamingMessageUpdate(update) {
			return false
		}
	}
	return true
}

func isCoalescibleStreamingMessageUpdate(update agentsessionstore.WorkspaceAgentMessageUpdate) bool {
	switch strings.ToLower(strings.TrimSpace(update.Kind)) {
	case "text", "reasoning", "tool_call":
	default:
		return false
	}
	switch strings.ToLower(strings.TrimSpace(update.Status)) {
	case "streaming", "running", "working", "in_progress":
		return strings.TrimSpace(update.MessageID) != ""
	default:
		return false
	}
}

func reportCoalesceSessionKey(report agentsessionstore.ReportActivityInput) string {
	workspaceID := strings.TrimSpace(report.WorkspaceID)
	agentSessionID := strings.TrimSpace(report.Source.AgentID)
	if agentSessionID == "" && len(report.MessageUpdates) > 0 {
		agentSessionID = strings.TrimSpace(report.MessageUpdates[0].AgentSessionID)
	}
	if workspaceID == "" || agentSessionID == "" {
		return ""
	}
	return workspaceID + "\n" + strings.TrimSpace(report.Source.SessionOrigin) + "\n" + agentSessionID
}

func reportCoalesceFallbackSessionKey(report agentsessionstore.ReportActivityInput) string {
	return strings.TrimSpace(report.WorkspaceID) + "\n" + strings.TrimSpace(report.Source.AgentID)
}

func reportMessageUpdateCoalesceKey(
	report agentsessionstore.ReportActivityInput,
	update agentsessionstore.WorkspaceAgentMessageUpdate,
) string {
	agentSessionID := strings.TrimSpace(update.AgentSessionID)
	if agentSessionID == "" {
		agentSessionID = strings.TrimSpace(report.Source.AgentID)
	}
	return agentSessionID + "\n" + strings.TrimSpace(update.MessageID)
}

func latestMessageUpdate(
	current agentsessionstore.WorkspaceAgentMessageUpdate,
	incoming agentsessionstore.WorkspaceAgentMessageUpdate,
) agentsessionstore.WorkspaceAgentMessageUpdate {
	earlier := incoming
	latest := current
	if incoming.Seq > current.Seq {
		earlier = current
		latest = incoming
	} else if incoming.Seq == current.Seq && incoming.OccurredAtUnixMS >= current.OccurredAtUnixMS {
		earlier = current
		latest = incoming
	}
	if strings.EqualFold(strings.TrimSpace(latest.Kind), "tool_call") {
		latest = mergeCoalescedToolCallUpdate(earlier, latest)
	}
	return latest
}

func mergeCoalescedToolCallUpdate(
	earlier agentsessionstore.WorkspaceAgentMessageUpdate,
	latest agentsessionstore.WorkspaceAgentMessageUpdate,
) agentsessionstore.WorkspaceAgentMessageUpdate {
	if latest.AgentSessionID == "" {
		latest.AgentSessionID = earlier.AgentSessionID
	}
	if latest.MessageID == "" {
		latest.MessageID = earlier.MessageID
	}
	if latest.TurnID == "" {
		latest.TurnID = earlier.TurnID
	}
	if latest.Role == "" {
		latest.Role = earlier.Role
	}
	if latest.Kind == "" {
		latest.Kind = earlier.Kind
	}
	if latest.Status == "" {
		latest.Status = earlier.Status
	}
	if latest.Semantics == nil {
		latest.Semantics = earlier.Semantics
	}
	if latest.CallID == "" {
		latest.CallID = earlier.CallID
	}
	if latest.ParentCallID == "" {
		latest.ParentCallID = earlier.ParentCallID
	}
	if latest.RootCallID == "" {
		latest.RootCallID = earlier.RootCallID
	}
	if latest.Title == "" {
		latest.Title = earlier.Title
	}
	latest.Payload = mergePendingToolCallPayload(earlier.Payload, latest.Payload)
	if earlier.StartedAtUnixMS > 0 &&
		(latest.StartedAtUnixMS <= 0 || earlier.StartedAtUnixMS < latest.StartedAtUnixMS) {
		latest.StartedAtUnixMS = earlier.StartedAtUnixMS
	}
	if earlier.CompletedAtUnixMS > latest.CompletedAtUnixMS {
		latest.CompletedAtUnixMS = earlier.CompletedAtUnixMS
	}
	return latest
}
