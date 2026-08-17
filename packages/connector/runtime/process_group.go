package runtime

import (
	"context"
	"errors"
	"sync"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
)

type trackedProcess struct {
	connection agentruntime.ProcessConnection
	cancel     context.CancelFunc
	closing    bool
}

// ProcessGroup fences process starts and owns every process launched for one
// connector route. It prevents a late start from escaping route retirement.
type ProcessGroup struct {
	mu            sync.Mutex
	processes     map[uint64]trackedProcess
	pendingStarts map[uint64]context.CancelFunc
	nextProcessID uint64
	fenced        bool
}

func NewProcessGroup() *ProcessGroup {
	return &ProcessGroup{processes: make(map[uint64]trackedProcess), pendingStarts: make(map[uint64]context.CancelFunc)}
}

func (group *ProcessGroup) Begin(parent context.Context) (context.Context, uint64, bool) {
	group.mu.Lock()
	defer group.mu.Unlock()
	if group.fenced {
		return nil, 0, false
	}
	processContext, cancel := context.WithCancel(parent)
	group.nextProcessID++
	group.pendingStarts[group.nextProcessID] = cancel
	return processContext, group.nextProcessID, true
}

func (group *ProcessGroup) FailStart(processID uint64) {
	group.mu.Lock()
	cancel := group.pendingStarts[processID]
	delete(group.pendingStarts, processID)
	group.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (group *ProcessGroup) CommitStart(processID uint64, connection agentruntime.ProcessConnection) bool {
	group.mu.Lock()
	defer group.mu.Unlock()
	cancel := group.pendingStarts[processID]
	delete(group.pendingStarts, processID)
	if group.fenced || cancel == nil {
		if cancel != nil {
			cancel()
		}
		return false
	}
	group.processes[processID] = trackedProcess{connection: connection, cancel: cancel}
	return true
}

func (group *ProcessGroup) Release(processID uint64, connection agentruntime.ProcessConnection) {
	_ = group.ReleaseWithError(processID, connection)
}

// ReleaseWithError releases an owned process and reports the transport close
// result. Release remains source-compatible for existing lifecycle callers.
func (group *ProcessGroup) ReleaseWithError(processID uint64, connection agentruntime.ProcessConnection) error {
	group.mu.Lock()
	current, owned := group.processes[processID]
	if owned && current.connection == connection && !current.closing {
		delete(group.processes, processID)
	} else {
		owned = false
	}
	group.mu.Unlock()
	if owned {
		current.cancel()
		return connection.Close()
	}
	return nil
}

func (group *ProcessGroup) Fence() {
	group.mu.Lock()
	group.fenced = true
	for processID, cancel := range group.pendingStarts {
		cancel()
		delete(group.pendingStarts, processID)
	}
	group.mu.Unlock()
}

func (group *ProcessGroup) IsFenced() bool {
	group.mu.Lock()
	defer group.mu.Unlock()
	return group.fenced
}

func (group *ProcessGroup) ActiveCount() int {
	group.mu.Lock()
	defer group.mu.Unlock()
	return len(group.processes)
}

func (group *ProcessGroup) Close(deadline time.Time) error {
	if group == nil {
		return nil
	}
	group.Fence()
	group.mu.Lock()
	processes := make(map[uint64]trackedProcess, len(group.processes))
	for processID, process := range group.processes {
		process.closing = true
		group.processes[processID] = process
		processes[processID] = process
	}
	group.mu.Unlock()
	type closeResult struct {
		processID uint64
		err       error
	}
	results := make(chan closeResult, len(processes))
	for processID, process := range processes {
		process.cancel()
		go func(processID uint64, connection agentruntime.ProcessConnection) {
			results <- closeResult{processID: processID, err: connection.Close()}
		}(processID, process.connection)
	}
	var closeErrors []error
	for range processes {
		var result closeResult
		if deadline.IsZero() {
			result = <-results
		} else {
			remaining := time.Until(deadline)
			if remaining <= 0 {
				return errors.Join(append(closeErrors, context.DeadlineExceeded)...)
			}
			timer := time.NewTimer(remaining)
			select {
			case result = <-results:
				if !timer.Stop() {
					<-timer.C
				}
			case <-timer.C:
				return errors.Join(append(closeErrors, context.DeadlineExceeded)...)
			}
		}
		if result.err != nil {
			closeErrors = append(closeErrors, result.err)
			continue
		}
		group.mu.Lock()
		if current, exists := group.processes[result.processID]; exists && current.connection == processes[result.processID].connection {
			delete(group.processes, result.processID)
		}
		group.mu.Unlock()
	}
	return errors.Join(closeErrors...)
}
