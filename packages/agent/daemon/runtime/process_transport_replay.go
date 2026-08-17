package agentruntime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	sessionreplay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

type ReplayProcessTransport struct {
	mu           sync.Mutex
	manifest     ProcessCassetteManifest
	connections  map[string][]processCassetteChunk
	records      map[string]ProcessCassetteConnectionRecord
	optional     map[string]bool
	launches     map[string]uint64
	consumed     map[string]bool
	sessionMap   map[string]string
	started      []*replayProcessConnection
	playback     *replayPlaybackController
	inputBarrier *replayProviderInputBarrier
}

func NewReplayProcessTransport(directory string) (*ReplayProcessTransport, error) {
	manifestRaw, err := os.ReadFile(filepath.Join(directory, processCassetteManifestName))
	if err != nil {
		return nil, fmt.Errorf("read process cassette manifest: %w", err)
	}
	var manifest ProcessCassetteManifest
	if err := json.Unmarshal(manifestRaw, &manifest); err != nil {
		return nil, fmt.Errorf("decode process cassette manifest: %w", err)
	}
	if manifest.SchemaVersion != ProcessCassetteSchemaVersion {
		return nil, fmt.Errorf(
			"unsupported process cassette schema version %d",
			manifest.SchemaVersion,
		)
	}
	if manifest.ProjectionVersion != ProcessCassetteProjectionVersion {
		return nil, fmt.Errorf(
			"unsupported process cassette projection version %d",
			manifest.ProjectionVersion,
		)
	}
	if manifest.Status != ProcessCassetteStatusComplete {
		return nil, fmt.Errorf("process cassette status is %q, want complete", manifest.Status)
	}
	framesPath := filepath.Join(directory, processCassetteChunksName)
	digest, err := fileSHA256(framesPath)
	if err != nil {
		return nil, fmt.Errorf("hash process cassette frames: %w", err)
	}
	if manifest.FramesSHA256 == "" || digest != manifest.FramesSHA256 {
		return nil, errors.New("process cassette frames integrity mismatch")
	}
	connections := make(map[string][]processCassetteChunk, len(manifest.Connections))
	records := make(map[string]ProcessCassetteConnectionRecord, len(manifest.Connections))
	optional := make(map[string]bool, len(manifest.Connections))
	for _, record := range manifest.Connections {
		descriptor, ok := sessionreplay.FindProviderReplayByProvider(record.Provider)
		if !ok {
			return nil, fmt.Errorf(
				"process cassette provider %q has no replay adapter",
				record.Provider,
			)
		}
		if !descriptor.SupportsFormat(
			manifest.SchemaVersion,
			manifest.ProjectionVersion,
		) || !processCassetteReplayAdapterSupported(descriptor) {
			return nil, fmt.Errorf(
				"process cassette provider %q has an incompatible replay adapter",
				record.Provider,
			)
		}
		switch record.CaptureOrigin {
		case ProcessCassetteCaptureOriginProcessStart,
			ProcessCassetteCaptureOriginAttachedLiveConnection:
		default:
			return nil, fmt.Errorf(
				"process cassette connection %q has unsupported capture origin %q",
				record.ConnectionID,
				record.CaptureOrigin,
			)
		}
	}
	chunksFile, err := os.Open(framesPath)
	if err != nil {
		return nil, fmt.Errorf("open process cassette chunks: %w", err)
	}
	defer func() { _ = chunksFile.Close() }()
	scanner := bufio.NewScanner(chunksFile)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	var globalSeq uint64
	for line := 1; scanner.Scan(); line++ {
		var chunk processCassetteChunk
		if err := json.Unmarshal(scanner.Bytes(), &chunk); err != nil {
			return nil, fmt.Errorf("decode process cassette chunk line %d: %w", line, err)
		}
		globalSeq++
		if chunk.GlobalSeq != globalSeq {
			return nil, fmt.Errorf(
				"process cassette global sequence is %d, want %d",
				chunk.GlobalSeq,
				globalSeq,
			)
		}
		connections[chunk.ConnectionID] = append(connections[chunk.ConnectionID], chunk)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read process cassette chunks: %w", err)
	}
	if globalSeq != manifest.FrameCount {
		return nil, fmt.Errorf(
			"process cassette frame count is %d, want %d",
			globalSeq,
			manifest.FrameCount,
		)
	}
	for _, connection := range manifest.Connections {
		descriptor, _ := sessionreplay.FindProviderReplayByProvider(
			connection.Provider,
		)
		key := processCassetteConnectionKey(
			connection.AgentSessionID,
			connection.Provider,
			connection.LaunchOrdinal,
		)
		if connection.LaunchOrdinal == 0 {
			return nil, fmt.Errorf("connection %s has no launch ordinal", connection.ConnectionID)
		}
		if _, duplicate := records[key]; duplicate {
			return nil, fmt.Errorf("duplicate process cassette connection key %s", key)
		}
		records[key] = connection
		chunks := connections[connection.ConnectionID]
		optional[key] = isOptionalReplayProbeConnection(
			descriptor,
			connection,
			chunks,
		)
		for index, chunk := range chunks {
			wantSeq := uint64(index + 1)
			if chunk.ChunkSeq != wantSeq {
				return nil, fmt.Errorf(
					"connection %s chunk sequence is %d, want %d",
					connection.ConnectionID,
					chunk.ChunkSeq,
					wantSeq,
				)
			}
		}
	}
	return &ReplayProcessTransport{
		manifest:     manifest,
		connections:  connections,
		records:      records,
		optional:     optional,
		launches:     map[string]uint64{},
		consumed:     map[string]bool{},
		sessionMap:   map[string]string{},
		playback:     newReplayPlaybackController(),
		inputBarrier: newReplayProviderInputBarrier(),
	}, nil
}

func (t *ReplayProcessTransport) SetReplayProviderCursor(
	targets []sessionreplay.ProviderUnitPosition,
) error {
	return t.inputBarrier.setTargets(targets)
}

func (t *ReplayProcessTransport) ClearReplayProviderCursor() {
	t.inputBarrier.clearTargets()
}

func (t *ReplayProcessTransport) ReplayProviderCursor() map[string]sessionreplay.ProviderUnitPosition {
	return t.inputBarrier.state()
}

func (t *ReplayProcessTransport) ReplayPlaybackState() ReplayPlaybackState {
	t.mu.Lock()
	defer t.mu.Unlock()
	state := t.playback.state()
	state.Drained = t.requiredConnectionsConsumed()
	for _, connection := range t.started {
		connection.mu.Lock()
		drained := connection.failure == nil && connection.cursor == len(connection.chunks)
		connection.mu.Unlock()
		if !drained {
			state.Drained = false
			break
		}
	}
	return state
}

func (t *ReplayProcessTransport) ReplayFailure() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, connection := range t.started {
		connection.mu.Lock()
		failure := connection.failure
		connection.mu.Unlock()
		if failure != nil {
			return failure
		}
	}
	return nil
}

func (t *ReplayProcessTransport) SetReplayPlaybackSpeed(speed float64) error {
	return t.playback.setSpeed(speed)
}

func (t *ReplayProcessTransport) PauseReplayPlayback() error {
	t.playback.setPaused(true)
	return nil
}

func (t *ReplayProcessTransport) ResumeReplayPlayback() error {
	t.playback.setPaused(false)
	return nil
}

func (t *ReplayProcessTransport) SetReplayPlaybackFastForward(enabled bool) error {
	t.playback.setFastForward(enabled)
	return nil
}

func (t *ReplayProcessTransport) Start(
	_ context.Context,
	spec ProcessSpec,
) (ProcessConnection, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	sessionID := normalizeProcessCassetteIdentity(spec.AgentSessionID)
	provider := normalizeProcessCassetteIdentity(spec.Provider)
	launchKey := sessionID + "\x00" + provider
	t.launches[launchKey]++
	recordedSessionID := t.sessionMap[sessionID]
	if recordedSessionID == "" {
		recordedSessionID = sessionID
	}
	key := processCassetteConnectionKey(recordedSessionID, provider, t.launches[launchKey])
	record, ok := t.records[key]
	if !ok {
		record, key, ok = t.resolveUnmappedRootConnection(
			spec,
			provider,
			t.launches[launchKey],
		)
		if !ok {
			return nil, fmt.Errorf(
				"process cassette has no connection for session %q provider %q launch %d",
				sessionID,
				provider,
				t.launches[launchKey],
			)
		}
		t.sessionMap[sessionID] = record.AgentSessionID
	}
	actualRoot := rootProcessSessionID(spec)
	mappedRoot := t.sessionMap[actualRoot]
	if mappedRoot == "" {
		mappedRoot = actualRoot
	}
	if recordedRoot := normalizeProcessCassetteIdentity(record.RootAgentSessionID); recordedRoot != "" &&
		mappedRoot != recordedRoot {
		return nil, fmt.Errorf(
			"process cassette root session mismatch for %s: got %q, want %q",
			record.ConnectionID,
			mappedRoot,
			recordedRoot,
		)
	}
	t.consumed[key] = true
	chunks := t.connections[record.ConnectionID]
	descriptor, ok := sessionreplay.FindProviderReplayByProvider(record.Provider)
	if !ok {
		return nil, fmt.Errorf(
			"process cassette provider %q has no replay adapter",
			record.Provider,
		)
	}
	connection := &replayProcessConnection{
		descriptor:    descriptor,
		connectionID:  record.ConnectionID,
		captureOrigin: record.CaptureOrigin,
		chunks:        chunks,
		closed:        make(chan struct{}),
		changed:       make(chan struct{}),
		holdOpen:      len(chunks) == 0 || chunks[len(chunks)-1].Kind != "exit",
		recordedCWD:   record.CWDToken,
		replayCWD:     processCassetteProtocolCWD(spec),
		replayHome: processCassetteReplayHome(
			spec,
			descriptor,
		),
		playback:       t.playback.newCursor(),
		inputBarrier:   t.inputBarrier,
		skippedRPCs:    map[string]struct{}{},
		responseIDs:    map[string]any{},
		identityValues: map[string]string{},
	}
	t.started = append(t.started, connection)
	return connection, nil
}

func (t *ReplayProcessTransport) resolveUnmappedRootConnection(
	spec ProcessSpec,
	provider string,
	ordinal uint64,
) (ProcessCassetteConnectionRecord, string, bool) {
	actualSessionID := normalizeProcessCassetteIdentity(spec.AgentSessionID)
	if rootProcessSessionID(spec) != actualSessionID {
		return ProcessCassetteConnectionRecord{}, "", false
	}
	var (
		match    ProcessCassetteConnectionRecord
		matchKey string
		count    int
	)
	for key, candidate := range t.records {
		if t.consumed[key] ||
			normalizeProcessCassetteIdentity(candidate.Provider) != provider ||
			candidate.LaunchOrdinal != ordinal ||
			normalizeProcessCassetteIdentity(candidate.AgentSessionID) !=
				normalizeProcessCassetteIdentity(candidate.RootAgentSessionID) {
			continue
		}
		match = candidate
		matchKey = key
		count++
	}
	return match, matchKey, count == 1
}

func (t *ReplayProcessTransport) VerifyComplete() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.requiredConnectionsConsumed() {
		required := 0
		consumed := 0
		for key := range t.records {
			if t.optional[key] {
				continue
			}
			required++
			if t.consumed[key] {
				consumed++
			}
		}
		return fmt.Errorf(
			"process cassette consumed %d of %d required connections",
			consumed,
			required,
		)
	}
	for _, connection := range t.started {
		if err := connection.verifyComplete(); err != nil {
			return err
		}
	}
	return nil
}

func (t *ReplayProcessTransport) requiredConnectionsConsumed() bool {
	for key := range t.records {
		if !t.optional[key] && !t.consumed[key] {
			return false
		}
	}
	return true
}

func (t *ReplayProcessTransport) Finalize() error {
	return t.VerifyComplete()
}

type replayProcessConnection struct {
	descriptor               sessionreplay.ProviderReplayDescriptor
	mu                       sync.Mutex
	recvMu                   sync.Mutex
	connectionID             string
	captureOrigin            ProcessCassetteCaptureOrigin
	chunks                   []processCassetteChunk
	cursor                   int
	failure                  error
	closed                   chan struct{}
	changed                  chan struct{}
	closeOnce                sync.Once
	closeErr                 error
	holdOpen                 bool
	recordedCWD              string
	replayCWD                string
	replayHome               string
	playback                 *replayPlaybackCursor
	inputBarrier             *replayProviderInputBarrier
	skippedRPCs              map[string]struct{}
	responseIDs              map[string]any
	identityValues           map[string]string
	skippingOptionalProbeRun bool
	// pendingSyntheticStdout holds JSON-RPC responses for optional probes that
	// were absorbed while inbound delivery was blocked. Callers such as
	// thread/goal/get NoHandler waits need a response or activation hangs until
	// acpStartCallTimeout.
	pendingSyntheticStdout [][]byte
}

func (c *replayProcessConnection) ProcessCassetteCaptureOrigin() ProcessCassetteCaptureOrigin {
	if c == nil {
		return ""
	}
	return c.captureOrigin
}

func (c *replayProcessConnection) WaitForProviderProgress(
	ctx context.Context,
	duration time.Duration,
) error {
	return c.inputBarrier.waitForProgressDuration(ctx, c.connectionID, duration, c.closed)
}

func (c *replayProcessConnection) Send(data []byte) error {
	for {
		c.mu.Lock()
		if c.isClosedLocked() {
			c.mu.Unlock()
			return io.ErrClosedPipe
		}
		if c.cursor >= len(c.chunks) {
			// Extra observational probes (for example child-nickname
			// thread/read retries) may fire after the tape ends. Absorb them
			// instead of failing the connection and blocking drain.
			if c.absorbOptionalProbeOutboundLocked(data) {
				c.mu.Unlock()
				return nil
			}
			err := c.failLocked(fmt.Errorf(
				"connection %s received unexpected outbound bytes after cassette end",
				c.connectionID,
			))
			c.mu.Unlock()
			return err
		}
		chunk := c.chunks[c.cursor]
		if chunk.Kind != "outbound" {
			// Don't queue optional probes behind inbound delivery. Synthesize an
			// empty JSON-RPC result so NoHandler callers (goal/get, thread/read)
			// do not sit on acpStartCallTimeout while the provider cursor is gated.
			if c.absorbOptionalProbeOutboundLocked(data) {
				c.mu.Unlock()
				return nil
			}
			changed := c.changed
			c.mu.Unlock()
			select {
			case <-c.closed:
				return io.ErrClosedPipe
			case <-changed:
			}
			continue
		}
		expected, err := base64.StdEncoding.DecodeString(chunk.Data)
		if err != nil {
			err = c.failLocked(fmt.Errorf("decode outbound chunk %d: %w", chunk.ChunkSeq, err))
			c.mu.Unlock()
			return err
		}
		responseIDs, identityValues, matches := processCassetteJSONMatch(
			c.descriptor,
			expected,
			data,
			c.recordedCWD,
			c.replayCWD,
			c.replayHome,
			c.identityValues,
		)
		if !bytes.Equal(data, expected) && !matches {
			if method, responseID, ok := processCassetteJSONRPCRequest(chunk); ok &&
				responseID != "" && c.descriptor.IsOptionalProbeMethod(method) {
				c.playback.advanceTo(chunk.ElapsedMS)
				c.skippedRPCs[responseID] = struct{}{}
				c.cursor++
				c.signalChangedLocked()
				c.mu.Unlock()
				continue
			}
			if c.absorbOptionalProbeOutboundLocked(data) {
				c.mu.Unlock()
				return nil
			}
			err = c.failLocked(processCassetteOutboundMismatch(chunk, expected, data))
			c.mu.Unlock()
			return err
		}
		for recordedID, replayID := range responseIDs {
			c.responseIDs[recordedID] = replayID
		}
		for recordedValue, replayValue := range identityValues {
			c.identityValues[recordedValue] = replayValue
		}
		c.skippingOptionalProbeRun = false
		c.playback.advanceTo(chunk.ElapsedMS)
		c.cursor++
		c.maybeSynthesizeImmediateStartupMetadataLocked(expected, data)
		c.signalChangedLocked()
		c.mu.Unlock()
		return nil
	}
}

func (c *replayProcessConnection) failLocked(err error) error {
	if c.failure == nil {
		c.failure = err
	}
	return err
}

func (c *replayProcessConnection) CompleteProviderInputUnit(
	ctx context.Context,
	unit ProviderInputUnit,
) error {
	if unit.Position.ConnectionID != c.connectionID {
		return fmt.Errorf(
			"provider input unit connection is %q, want %q",
			unit.Position.ConnectionID,
			c.connectionID,
		)
	}
	for {
		c.mu.Lock()
		if len(c.pendingSyntheticStdout) > 0 {
			c.mu.Unlock()
			return errReplaySyntheticPending
		}
		interrupt := c.changed
		c.mu.Unlock()
		err := c.inputBarrier.complete(ctx, unit, c.closed, interrupt)
		if errors.Is(err, errReplaySyntheticPending) {
			// Absorb may have raced after the snapshot; re-check pending.
			c.mu.Lock()
			pending := len(c.pendingSyntheticStdout) > 0
			c.mu.Unlock()
			if pending {
				return errReplaySyntheticPending
			}
			continue
		}
		return err
	}
}

func (c *replayProcessConnection) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.isClosedLocked()
}

func (c *replayProcessConnection) Close() error {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		if c.cursor != len(c.chunks) {
			c.closeErr = fmt.Errorf(
				"connection %s consumed %d of %d chunks",
				c.connectionID,
				c.cursor,
				len(c.chunks),
			)
		}
		close(c.closed)
		c.signalChangedLocked()
		c.mu.Unlock()
	})
	return c.closeErr
}

func (c *replayProcessConnection) signalChangedLocked() {
	close(c.changed)
	c.changed = make(chan struct{})
}

func (*replayProcessConnection) CloseInput() error {
	return nil
}

func (c *replayProcessConnection) Terminate() error {
	return c.Close()
}

func (c *replayProcessConnection) Kill() error {
	return c.Close()
}

func (c *replayProcessConnection) isClosedLocked() bool {
	select {
	case <-c.closed:
		return true
	default:
		return false
	}
}

func (c *replayProcessConnection) verifyComplete() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.failure != nil {
		return c.failure
	}
	if c.cursor != len(c.chunks) {
		return fmt.Errorf(
			"connection %s consumed %d of %d chunks",
			c.connectionID,
			c.cursor,
			len(c.chunks),
		)
	}
	return nil
}
