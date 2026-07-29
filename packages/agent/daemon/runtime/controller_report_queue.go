package agentruntime

import (
	"sync"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
)

// reportRequestQueue is an unbounded FIFO with a single non-blocking wake-up
// signal. Pending streaming snapshots are coalesced before they can become a
// backlog. Producers may be re-entered from reporter observers, so they must
// never call the reporter inline or wait for the sole consumer.
type reportRequestQueue struct {
	mu               sync.Mutex
	items            []*reportRequest
	head             int
	pendingStreaming map[string]*reportRequest
	readyCh          chan struct{}
}

func newReportRequestQueue() *reportRequestQueue {
	return &reportRequestQueue{
		pendingStreaming: make(map[string]*reportRequest),
		readyCh:          make(chan struct{}, 1),
	}
}

func (q *reportRequestQueue) enqueue(request reportRequest) int {
	if q == nil {
		return 0
	}
	q.mu.Lock()
	streamingKey := queuedStreamingReportKey(request)
	if streamingKey != "" {
		if pending := q.pendingStreaming[streamingKey]; pending != nil {
			mergeQueuedStreamingReport(pending, request)
			depth := len(q.items) - q.head
			q.mu.Unlock()
			return depth
		}
	} else {
		delete(q.pendingStreaming, queuedReportSessionKey(request.report))
	}
	queued := request
	q.items = append(q.items, &queued)
	if streamingKey != "" {
		q.pendingStreaming[streamingKey] = &queued
	}
	depth := len(q.items) - q.head
	q.mu.Unlock()
	select {
	case q.readyCh <- struct{}{}:
	default:
	}
	return depth
}

func (q *reportRequestQueue) dequeue() (reportRequest, bool) {
	if q == nil {
		return reportRequest{}, false
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.head >= len(q.items) {
		return reportRequest{}, false
	}
	queued := q.items[q.head]
	request := *queued
	if streamingKey := queuedStreamingReportKey(request); streamingKey != "" &&
		q.pendingStreaming[streamingKey] == queued {
		delete(q.pendingStreaming, streamingKey)
	}
	q.items[q.head] = nil
	q.head++
	if q.head == len(q.items) {
		q.items = nil
		q.head = 0
	} else if q.head >= 1024 && q.head*2 >= len(q.items) {
		remaining := append([]*reportRequest(nil), q.items[q.head:]...)
		q.items = remaining
		q.head = 0
	}
	return request, true
}

func queuedStreamingReportKey(request reportRequest) string {
	if request.submitProvenance || request.done != nil || !isCoalescibleStreamingReport(request.report) {
		return ""
	}
	return queuedReportSessionKey(request.report)
}

func queuedReportSessionKey(report agentsessionstore.ReportActivityInput) string {
	if key := reportCoalesceSessionKey(report); key != "" {
		return key
	}
	return reportCoalesceFallbackSessionKey(report)
}

func mergeQueuedStreamingReport(current *reportRequest, incoming reportRequest) {
	if current == nil {
		return
	}
	current.ctx = incoming.ctx
	indexByMessageKey := make(map[string]int, len(current.report.MessageUpdates))
	for index, update := range current.report.MessageUpdates {
		indexByMessageKey[reportMessageUpdateCoalesceKey(current.report, update)] = index
	}
	for _, update := range incoming.report.MessageUpdates {
		messageKey := reportMessageUpdateCoalesceKey(incoming.report, update)
		if index, ok := indexByMessageKey[messageKey]; ok {
			current.report.MessageUpdates[index] = latestMessageUpdate(
				current.report.MessageUpdates[index],
				update,
			)
			continue
		}
		indexByMessageKey[messageKey] = len(current.report.MessageUpdates)
		current.report.MessageUpdates = append(current.report.MessageUpdates, update)
	}
}

func (q *reportRequestQueue) ready() <-chan struct{} {
	if q == nil {
		return nil
	}
	return q.readyCh
}
