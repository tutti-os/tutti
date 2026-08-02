package agentruntime

import (
	"strings"
	"sync"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
)

// goalObservationRequestQueue preserves FIFO within one Session while letting
// unrelated Sessions make progress independently. A queue entry remains in
// the map while its head is retrying, so only the same Session is serialized.
type goalObservationRequestQueue struct {
	mu        sync.Mutex
	bySession map[string]*goalObservationSessionQueue
}

type goalObservationSessionQueue struct {
	items []*reportRequest
	head  int
}

func newGoalObservationRequestQueue() *goalObservationRequestQueue {
	return &goalObservationRequestQueue{
		bySession: make(map[string]*goalObservationSessionQueue),
	}
}

func (q *goalObservationRequestQueue) enqueue(request reportRequest) (string, bool) {
	if q == nil {
		return "", false
	}
	key := goalObservationReportSessionKey(request.report)
	if key == "" {
		return "", false
	}
	q.mu.Lock()
	queue := q.bySession[key]
	startWorker := queue == nil
	if queue == nil {
		queue = &goalObservationSessionQueue{}
		q.bySession[key] = queue
	}
	queued := request
	queue.items = append(queue.items, &queued)
	q.mu.Unlock()
	return key, startWorker
}

func (q *goalObservationRequestQueue) dequeue(sessionKey string) (reportRequest, bool) {
	if q == nil || strings.TrimSpace(sessionKey) == "" {
		return reportRequest{}, false
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	queue := q.bySession[sessionKey]
	if queue == nil || queue.head >= len(queue.items) {
		delete(q.bySession, sessionKey)
		return reportRequest{}, false
	}
	queued := queue.items[queue.head]
	request := *queued
	queue.items[queue.head] = nil
	queue.head++
	if queue.head >= 1024 && queue.head*2 >= len(queue.items) {
		queue.items = append([]*reportRequest(nil), queue.items[queue.head:]...)
		queue.head = 0
	}
	return request, true
}

func goalObservationReportSessionKey(report agentsessionstore.ReportActivityInput) string {
	workspaceID := strings.TrimSpace(report.WorkspaceID)
	agentSessionID := strings.TrimSpace(report.Source.AgentID)
	if agentSessionID == "" && len(report.GoalReconcileRequests) > 0 {
		agentSessionID = strings.TrimSpace(report.GoalReconcileRequests[0].AgentSessionID)
	}
	if workspaceID == "" || agentSessionID == "" {
		return ""
	}
	return workspaceID + "\n" + agentSessionID
}
