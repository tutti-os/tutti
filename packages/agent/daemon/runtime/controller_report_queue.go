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
	index := q.nextDequeueIndexLocked()
	queued := q.items[index]
	request := *queued
	if streamingKey := queuedStreamingReportKey(request); streamingKey != "" &&
		q.pendingStreaming[streamingKey] == queued {
		delete(q.pendingStreaming, streamingKey)
	}
	if index == q.head {
		q.items[q.head] = nil
		q.head++
	} else {
		copy(q.items[index:], q.items[index+1:])
		q.items[len(q.items)-1] = nil
		q.items = q.items[:len(q.items)-1]
	}
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

// nextDequeueIndexLocked preserves causal order within a session while
// allowing a durable completion/barrier from another session to make progress.
// Without this exception, a busy stream can keep the single report worker
// occupied long enough for reportSessionBeforePublish to time out.
func (q *reportRequestQueue) nextDequeueIndexLocked() int {
	seenSessionKeys := make(map[string]struct{})
	if q.head < len(q.items) && q.items[q.head] != nil {
		if sessionKey := queuedReportSessionKey(q.items[q.head].report); sessionKey != "" {
			seenSessionKeys[sessionKey] = struct{}{}
		}
	}
	for index := q.head + 1; index < len(q.items); index++ {
		candidate := q.items[index]
		if candidate == nil {
			continue
		}
		sessionKey := queuedReportSessionKey(candidate.report)
		if isReportBarrierRequest(*candidate) && sessionKey != "" {
			if _, hasEarlier := seenSessionKeys[sessionKey]; !hasEarlier {
				return index
			}
		}
		if sessionKey != "" {
			seenSessionKeys[sessionKey] = struct{}{}
		}
	}
	return q.head
}

func isReportBarrierRequest(request reportRequest) bool {
	return request.barrier || request.done != nil
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
