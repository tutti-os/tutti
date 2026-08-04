package workspace

import (
	"log/slog"
	"sync"
	"time"
)

type terminalRuntimeSession struct {
	mu           sync.Mutex
	cols         int
	createdAt    time.Time
	cwd          string
	endedAt      *time.Time
	id           string
	lastError    *string
	output       string
	outputChunks []terminalOutputChunk
	outputChars  int
	profileID    *string
	process      TerminalProcess
	rows         int
	seq          int64
	shell        string
	status       TerminalStatus
	subscribers  map[chan TerminalStreamEvent]struct{}
	title        string
	updatedAt    *time.Time
	workspaceID  string
}

type terminalForegroundProcess struct {
	hasForegroundProcess bool
	leaderCommand        *string
}

type terminalOutputChunk struct {
	data string
	seq  int64
}

func (s *terminalRuntimeSession) snapshot() TerminalSession {
	s.mu.Lock()
	defer s.mu.Unlock()

	cwd := s.cwd
	return TerminalSession{
		Cols:        s.cols,
		CreatedAt:   s.createdAt,
		Cwd:         &cwd,
		EndedAt:     cloneTimePointer(s.endedAt),
		ID:          s.id,
		LastError:   cloneStringPointer(s.lastError),
		ProfileID:   cloneStringPointer(s.profileID),
		Rows:        s.rows,
		Status:      s.status,
		Title:       s.title,
		UpdatedAt:   cloneTimePointer(s.updatedAt),
		WorkspaceID: s.workspaceID,
	}
}

func (s *terminalRuntimeSession) outputSnapshot() TerminalSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()

	data := s.output
	truncated := false
	if len(data) > maxTerminalSnapshotChars {
		data = data[len(data)-maxTerminalSnapshotChars:]
		truncated = true
	}
	toSeq := s.seq
	fromSeq := s.firstOutputSeqLocked()
	updatedAt := time.Now().UTC().UnixMilli()
	return TerminalSnapshot{
		Data:      data,
		FromSeq:   fromSeq,
		ToSeq:     &toSeq,
		Truncated: &truncated,
		UpdatedAt: &updatedAt,
	}
}

func (s *terminalRuntimeSession) write(data string) error {
	s.mu.Lock()
	if isEndedTerminalStatus(s.status) {
		s.mu.Unlock()
		return ErrTerminalNotRunning
	}
	process := s.process
	s.mu.Unlock()

	if process == nil {
		return ErrTerminalNotRunning
	}
	_, err := process.Write([]byte(data))
	return err
}

func (s *terminalRuntimeSession) attachStream(input AttachTerminalInput) TerminalStream {
	ch := make(chan TerminalStreamEvent, 1024)
	var replay []TerminalStreamEvent
	var endedEvent *TerminalStreamEvent
	var gapFromSeq *int64
	var gapToSeq *int64
	replayOutputCount := 0
	subscriberCount := 0

	s.mu.Lock()
	if s.subscribers == nil {
		s.subscribers = make(map[chan TerminalStreamEvent]struct{})
	}
	s.subscribers[ch] = struct{}{}
	subscriberCount = len(s.subscribers)
	if s.status == TerminalStatusDetached {
		s.status = TerminalStatusRunning
		s.touchLocked()
	}

	firstSeq := s.firstOutputSeqLocked()
	afterSeq := int64(0)
	if input.AfterSeq != nil {
		afterSeq = *input.AfterSeq
	}
	if firstSeq != nil && afterSeq > 0 && afterSeq < *firstSeq-1 {
		fromSeq := afterSeq + 1
		toSeq := *firstSeq - 1
		gapFromSeq = &fromSeq
		gapToSeq = &toSeq
		replay = append(replay, TerminalStreamEvent{
			Type:      TerminalStreamEventGap,
			SessionID: s.id,
			FromSeq:   &fromSeq,
			ToSeq:     &toSeq,
			Status:    s.status,
		})
	}
	for _, chunk := range s.outputChunks {
		if chunk.seq > afterSeq {
			replayOutputCount += 1
			seq := chunk.seq
			replay = append(replay, TerminalStreamEvent{
				Type:      TerminalStreamEventOutput,
				SessionID: s.id,
				Data:      chunk.data,
				Seq:       &seq,
				Status:    s.status,
			})
		}
	}
	replay = append(replay, s.metadataEventLocked())
	replay = append(replay, TerminalStreamEvent{
		Type:      TerminalStreamEventState,
		SessionID: s.id,
		Status:    s.status,
		Error:     cloneStringPointer(s.lastError),
	})
	if isEndedTerminalStatus(s.status) {
		ended := TerminalStreamEvent{
			Type:      TerminalStreamEventExit,
			SessionID: s.id,
			Status:    s.status,
			Error:     cloneStringPointer(s.lastError),
		}
		endedEvent = &ended
	}
	snapshot := s.snapshotLocked()
	s.mu.Unlock()
	slog.Info(
		"workspace terminal attach stream prepared",
		"event", "workspace.terminal.attach",
		"workspace_id", s.workspaceID,
		"terminal_session_id", s.id,
		"after_seq", nullableInt64Value(input.AfterSeq),
		"gap_from_seq", nullableInt64Value(gapFromSeq),
		"gap_to_seq", nullableInt64Value(gapToSeq),
		"replay_event_count", len(replay),
		"replay_output_count", replayOutputCount,
		"status", string(snapshot.Status),
		"subscriber_count", subscriberCount,
	)

	go func() {
		for _, event := range replay {
			ch <- event
		}
		if endedEvent != nil {
			ch <- *endedEvent
		}
	}()

	var once sync.Once
	return TerminalStream{
		Events:  ch,
		Session: snapshot,
		close: func() {
			once.Do(func() {
				var detachedEvent *TerminalStreamEvent
				s.mu.Lock()
				delete(s.subscribers, ch)
				if len(s.subscribers) == 0 && !isEndedTerminalStatus(s.status) {
					s.status = TerminalStatusDetached
					s.touchLocked()
					detached := TerminalStreamEvent{
						Type:      TerminalStreamEventState,
						SessionID: s.id,
						Status:    TerminalStatusDetached,
					}
					detachedEvent = &detached
				}
				s.mu.Unlock()
				if detachedEvent != nil {
					slog.Info(
						"workspace terminal stream detached",
						"event", "workspace.terminal.detach",
						"workspace_id", s.workspaceID,
						"terminal_session_id", s.id,
					)
					s.broadcast(*detachedEvent)
				}
			})
		},
	}
}

func (s *terminalRuntimeSession) readLoop() {
	buffer := make([]byte, 32*1024)
	for {
		n, err := s.process.Read(buffer)
		if n > 0 {
			s.appendOutput(string(buffer[:n]))
		}
		if err != nil {
			if !isTerminalReadEOF(err) {
				s.recordError(err)
			}
			return
		}
	}
}

func (s *terminalRuntimeSession) waitLoop() {
	err := s.process.Wait()
	_ = s.process.Close()
	s.mu.Lock()

	if isEndedTerminalStatus(s.status) {
		s.mu.Unlock()
		return
	}
	now := time.Now().UTC()
	s.endedAt = &now
	s.updatedAt = &now
	if err != nil {
		message := err.Error()
		code, signal := describeTerminalExit(err)
		s.lastError = &message
		s.status = TerminalStatusFailed
		event := TerminalStreamEvent{
			Type:      TerminalStreamEventExit,
			SessionID: s.id,
			Status:    s.status,
			Error:     &message,
			Code:      code,
			Signal:    signal,
		}
		s.mu.Unlock()
		s.broadcast(event)
		return
	}
	s.status = TerminalStatusExited
	event := TerminalStreamEvent{
		Type:      TerminalStreamEventExit,
		SessionID: s.id,
		Status:    s.status,
	}
	s.mu.Unlock()
	s.broadcast(event)
}

func (s *terminalRuntimeSession) appendOutput(data string) {
	s.mu.Lock()

	s.output += data
	if len(s.output) > maxTerminalSnapshotChars*2 {
		s.output = s.output[len(s.output)-maxTerminalSnapshotChars:]
	}
	s.seq += 1
	seq := s.seq
	s.outputChunks = append(s.outputChunks, terminalOutputChunk{data: data, seq: seq})
	s.outputChars += len(data)
	for s.outputChars > maxTerminalReplayChars && len(s.outputChunks) > 0 {
		s.outputChars -= len(s.outputChunks[0].data)
		s.outputChunks = s.outputChunks[1:]
	}
	s.touchLocked()
	status := s.status
	s.mu.Unlock()

	s.broadcast(TerminalStreamEvent{
		Type:      TerminalStreamEventOutput,
		SessionID: s.id,
		Data:      data,
		Seq:       &seq,
		Status:    status,
	})
}

func (s *terminalRuntimeSession) recordError(err error) {
	s.mu.Lock()

	if isEndedTerminalStatus(s.status) {
		s.mu.Unlock()
		return
	}
	message := err.Error()
	s.lastError = &message
	s.status = TerminalStatusFailed
	now := time.Now().UTC()
	s.endedAt = &now
	s.updatedAt = &now
	s.mu.Unlock()

	s.broadcast(TerminalStreamEvent{
		Type:      TerminalStreamEventError,
		SessionID: s.id,
		Status:    TerminalStatusFailed,
		Error:     &message,
	})
}

func (s *terminalRuntimeSession) touchLocked() {
	now := time.Now().UTC()
	s.updatedAt = &now
}

func (s *terminalRuntimeSession) snapshotLocked() TerminalSession {
	cwd := s.cwd
	return TerminalSession{
		Cols:        s.cols,
		CreatedAt:   s.createdAt,
		Cwd:         &cwd,
		EndedAt:     cloneTimePointer(s.endedAt),
		ID:          s.id,
		LastError:   cloneStringPointer(s.lastError),
		ProfileID:   cloneStringPointer(s.profileID),
		Rows:        s.rows,
		Status:      s.status,
		Title:       s.title,
		UpdatedAt:   cloneTimePointer(s.updatedAt),
		WorkspaceID: s.workspaceID,
	}
}

func (s *terminalRuntimeSession) firstOutputSeqLocked() *int64 {
	if len(s.outputChunks) == 0 {
		return nil
	}
	first := s.outputChunks[0].seq
	return &first
}

func (s *terminalRuntimeSession) broadcast(event TerminalStreamEvent) {
	s.mu.Lock()
	subscribers := make([]chan TerminalStreamEvent, 0, len(s.subscribers))
	for subscriber := range s.subscribers {
		subscribers = append(subscribers, subscriber)
	}
	s.mu.Unlock()

	for _, subscriber := range subscribers {
		select {
		case subscriber <- event:
		default:
			slog.Warn(
				"workspace terminal subscriber backlog dropped event",
				"event", "workspace.terminal.stream.drop",
				"terminal_session_id", event.SessionID,
				"stream_event_type", string(event.Type),
				"stream_event_seq", nullableInt64Value(event.Seq),
				"subscriber_buffer_cap", cap(subscriber),
				"subscriber_buffer_len", len(subscriber),
			)
		}
	}
}

func (s *terminalRuntimeSession) metadataEventLocked() TerminalStreamEvent {
	cwd := s.cwd
	runtimeKind := "local"
	title := s.title
	return TerminalStreamEvent{
		Type:        TerminalStreamEventMeta,
		SessionID:   s.id,
		Cwd:         &cwd,
		ProfileID:   cloneStringPointer(s.profileID),
		RuntimeKind: &runtimeKind,
		Title:       &title,
	}
}

func boolValue(value *bool) bool {
	return value != nil && *value
}

func nullableInt64Value(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}
