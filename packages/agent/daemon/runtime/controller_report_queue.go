package agentruntime

import "sync"

// reportRequestQueue is an unbounded FIFO with a single non-blocking wake-up
// signal. Producers may be re-entered from reporter observers, so they must
// never call the reporter inline or wait for the sole consumer.
type reportRequestQueue struct {
	mu      sync.Mutex
	items   []reportRequest
	head    int
	readyCh chan struct{}
}

func newReportRequestQueue() *reportRequestQueue {
	return &reportRequestQueue{readyCh: make(chan struct{}, 1)}
}

func (q *reportRequestQueue) enqueue(request reportRequest) int {
	if q == nil {
		return 0
	}
	q.mu.Lock()
	q.items = append(q.items, request)
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
	request := q.items[q.head]
	q.items[q.head] = reportRequest{}
	q.head++
	if q.head == len(q.items) {
		q.items = nil
		q.head = 0
	} else if q.head >= 1024 && q.head*2 >= len(q.items) {
		remaining := append([]reportRequest(nil), q.items[q.head:]...)
		q.items = remaining
		q.head = 0
	}
	return request, true
}

func (q *reportRequestQueue) ready() <-chan struct{} {
	if q == nil {
		return nil
	}
	return q.readyCh
}
