package agentruntime

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

const processCassetteSchemaVersion = 2

var (
	processCassetteManifestName = "manifest.json"
	processCassetteChunksName   = "frames.jsonl"
	// Provider traffic is expected to be protocol messages, not a bulk file
	// archive. These limits fail the recording before one Session can silently
	// consume unbounded disk space.
	processCassetteMaxPayloadBytes = uint64(replay.MaxProviderPayloadBytes)
	processCassetteMaxStoredBytes  = uint64(replay.MaxProviderTapeBytes)
)

var ErrProcessCassetteSizeLimit = errors.New("process cassette size limit exceeded")

type ProcessCassetteStatus string

const (
	ProcessCassetteStatusIncomplete ProcessCassetteStatus = "incomplete"
	ProcessCassetteStatusComplete   ProcessCassetteStatus = "complete"
)

type ProcessCassetteManifest struct {
	SchemaVersion int                                 `json:"schemaVersion"`
	Status        ProcessCassetteStatus               `json:"status"`
	FrameCount    uint64                              `json:"frameCount"`
	PayloadBytes  uint64                              `json:"payloadBytes"`
	StoredBytes   uint64                              `json:"storedBytes"`
	MaxFrameBytes uint64                              `json:"maxFrameBytes"`
	Limits        ProcessCassetteLimits               `json:"limits"`
	FramesByKind  map[string]ProcessCassetteKindStats `json:"framesByKind"`
	FramesSHA256  string                              `json:"framesSha256"`
	Connections   []ProcessCassetteConnectionRecord   `json:"connections"`
}

type ProcessCassetteLimits struct {
	MaxFrameBytes  uint64 `json:"maxFrameBytes"`
	MaxStoredBytes uint64 `json:"maxStoredBytes"`
}

type ProcessCassetteKindStats struct {
	FrameCount   uint64 `json:"frameCount"`
	PayloadBytes uint64 `json:"payloadBytes"`
	StoredBytes  uint64 `json:"storedBytes"`
}

type ProcessCassetteConnectionRecord struct {
	ConnectionID       string `json:"connectionId"`
	Provider           string `json:"provider"`
	AgentSessionID     string `json:"agentSessionId"`
	RootAgentSessionID string `json:"rootAgentSessionId"`
	LaunchOrdinal      uint64 `json:"launchOrdinal"`
	CWDToken           string `json:"cwdToken"`
}

type processCassetteChunk struct {
	ConnectionID string `json:"connectionId"`
	ChunkSeq     uint64 `json:"chunkSeq"`
	GlobalSeq    uint64 `json:"globalSeq"`
	ElapsedMS    int64  `json:"elapsedMs"`
	Kind         string `json:"kind"`
	Data         string `json:"data,omitempty"`
	ExitCode     *int   `json:"exitCode,omitempty"`
	Message      string `json:"message,omitempty"`
}

type processCassetteWriter struct {
	mu              sync.Mutex
	directory       string
	chunks          *os.File
	manifest        ProcessCassetteManifest
	nextConnection  uint64
	nextGlobalSeq   uint64
	sessionLaunches map[string]uint64
	connectionCWD   map[string]processCassetteCWD
	maxPayloadBytes uint64
	maxStoredBytes  uint64
	active          int
	finalized       bool
}

type processCassetteCWD struct {
	recorded string
	token    string
}

func newProcessCassetteWriter(directory string) (*processCassetteWriter, error) {
	directory = strings.TrimSpace(directory)
	if directory == "" {
		return nil, errors.New("process cassette directory is required")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("create process cassette directory: %w", err)
	}
	chunks, err := os.OpenFile(
		filepath.Join(directory, processCassetteChunksName),
		os.O_CREATE|os.O_TRUNC|os.O_WRONLY,
		0o600,
	)
	if err != nil {
		return nil, fmt.Errorf("create process cassette chunks: %w", err)
	}
	writer := &processCassetteWriter{
		directory: directory,
		chunks:    chunks,
		manifest: ProcessCassetteManifest{
			SchemaVersion: processCassetteSchemaVersion,
			Status:        ProcessCassetteStatusIncomplete,
			Limits: ProcessCassetteLimits{
				MaxFrameBytes:  processCassetteMaxPayloadBytes,
				MaxStoredBytes: processCassetteMaxStoredBytes,
			},
			FramesByKind: map[string]ProcessCassetteKindStats{},
		},
		sessionLaunches: map[string]uint64{},
		connectionCWD:   map[string]processCassetteCWD{},
		maxPayloadBytes: processCassetteMaxPayloadBytes,
		maxStoredBytes:  processCassetteMaxStoredBytes,
	}
	if err := writer.writeManifestLocked(); err != nil {
		_ = chunks.Close()
		return nil, err
	}
	return writer, nil
}

func (w *processCassetteWriter) start(spec ProcessSpec) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.finalized {
		return "", errors.New("process cassette is already finalized")
	}
	w.nextConnection++
	connectionID := fmt.Sprintf("connection-%d", w.nextConnection)
	sessionKey := normalizeProcessCassetteIdentity(spec.AgentSessionID)
	w.sessionLaunches[sessionKey]++
	cwdToken := fmt.Sprintf("${SESSION_CWD:%s:%d}", sessionKey, w.sessionLaunches[sessionKey])
	w.manifest.Connections = append(w.manifest.Connections, ProcessCassetteConnectionRecord{
		ConnectionID:       connectionID,
		Provider:           spec.Provider,
		AgentSessionID:     spec.AgentSessionID,
		RootAgentSessionID: rootProcessSessionID(spec),
		LaunchOrdinal:      w.sessionLaunches[sessionKey],
		CWDToken:           cwdToken,
	})
	w.connectionCWD[connectionID] = processCassetteCWD{
		recorded: strings.TrimSpace(spec.CWD),
		token:    cwdToken,
	}
	w.active++
	if err := w.writeManifestLocked(); err != nil {
		w.active--
		w.manifest.Connections = w.manifest.Connections[:len(w.manifest.Connections)-1]
		delete(w.connectionCWD, connectionID)
		return "", err
	}
	return connectionID, nil
}

func (w *processCassetteWriter) append(chunk processCassetteChunk) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.finalized {
		return errors.New("process cassette is already finalized")
	}
	w.nextGlobalSeq++
	chunk.GlobalSeq = w.nextGlobalSeq
	if cwd := w.connectionCWD[chunk.ConnectionID]; cwd.recorded != "" {
		chunk = mapProcessCassetteChunkPaths(chunk, cwd.recorded, cwd.token)
	}
	raw, err := json.Marshal(chunk)
	if err != nil {
		return fmt.Errorf("encode process cassette chunk: %w", err)
	}
	raw = append(raw, '\n')
	payloadBytes, err := processCassetteChunkPayloadBytes(chunk)
	if err != nil {
		return err
	}
	if payloadBytes > w.maxPayloadBytes {
		return fmt.Errorf(
			"%w: %s frame payload is %d bytes, limit is %d bytes",
			ErrProcessCassetteSizeLimit,
			chunk.Kind,
			payloadBytes,
			w.maxPayloadBytes,
		)
	}
	projectedStoredBytes := w.manifest.StoredBytes + uint64(len(raw))
	if projectedStoredBytes > w.maxStoredBytes {
		return fmt.Errorf(
			"%w: provider frames would use %d bytes, limit is %d bytes",
			ErrProcessCassetteSizeLimit,
			projectedStoredBytes,
			w.maxStoredBytes,
		)
	}
	if _, err := w.chunks.Write(raw); err != nil {
		return fmt.Errorf("write process cassette chunk: %w", err)
	}
	storedBytes := uint64(len(raw))
	w.manifest.PayloadBytes += payloadBytes
	w.manifest.StoredBytes = projectedStoredBytes
	if payloadBytes > w.manifest.MaxFrameBytes {
		w.manifest.MaxFrameBytes = payloadBytes
	}
	stats := w.manifest.FramesByKind[chunk.Kind]
	stats.FrameCount++
	stats.PayloadBytes += payloadBytes
	stats.StoredBytes += storedBytes
	w.manifest.FramesByKind[chunk.Kind] = stats
	return nil
}

func processCassetteChunkPayloadBytes(chunk processCassetteChunk) (uint64, error) {
	payloadBytes := uint64(len(chunk.Message))
	if chunk.Data == "" {
		return payloadBytes, nil
	}
	data, err := base64.StdEncoding.DecodeString(chunk.Data)
	if err != nil {
		return 0, fmt.Errorf("decode process cassette %s payload for size accounting: %w", chunk.Kind, err)
	}
	return payloadBytes + uint64(len(data)), nil
}

func mapProcessCassetteChunkPaths(
	chunk processCassetteChunk,
	oldValue string,
	newValue string,
) processCassetteChunk {
	if chunk.Data == "" {
		return chunk
	}
	data, err := base64.StdEncoding.DecodeString(chunk.Data)
	if err != nil {
		return chunk
	}
	mapped := mapProcessCassetteFrameJSON(data, oldValue, newValue)
	chunk.Data = base64.StdEncoding.EncodeToString(mapped)
	return chunk
}

func (w *processCassetteWriter) finishConnection() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.active > 0 {
		w.active--
	}
	return nil
}

func (w *processCassetteWriter) finalize() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.finalized {
		return nil
	}
	if w.active != 0 {
		return fmt.Errorf("cannot finalize process cassette with %d active connections", w.active)
	}
	if err := w.chunks.Sync(); err != nil {
		return fmt.Errorf("sync process cassette chunks: %w", err)
	}
	if err := w.chunks.Close(); err != nil {
		return fmt.Errorf("close process cassette chunks: %w", err)
	}
	digest, err := fileSHA256(filepath.Join(w.directory, processCassetteChunksName))
	if err != nil {
		return fmt.Errorf("hash process cassette frames: %w", err)
	}
	w.manifest.FrameCount = w.nextGlobalSeq
	w.manifest.FramesSHA256 = digest
	w.manifest.Status = ProcessCassetteStatusComplete
	if err := w.writeManifestLocked(); err != nil {
		return err
	}
	w.finalized = true
	return nil
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func (w *processCassetteWriter) abort() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.finalized {
		return nil
	}
	var result error
	if err := w.chunks.Sync(); err != nil {
		result = errors.Join(result, fmt.Errorf("sync process cassette chunks: %w", err))
	}
	if err := w.chunks.Close(); err != nil {
		result = errors.Join(result, fmt.Errorf("close process cassette chunks: %w", err))
	}
	w.finalized = true
	return result
}

func (w *processCassetteWriter) writeManifestLocked() error {
	raw, err := json.MarshalIndent(w.manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encode process cassette manifest: %w", err)
	}
	raw = append(raw, '\n')
	path := filepath.Join(w.directory, processCassetteManifestName)
	tempPath := path + ".tmp"
	if err := os.WriteFile(tempPath, raw, 0o600); err != nil {
		return fmt.Errorf("write process cassette manifest: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("replace process cassette manifest: %w", err)
	}
	return nil
}

func processCassetteFrameChunk(
	connectionID string,
	seq uint64,
	elapsed time.Duration,
	frame ProcessFrame,
) (processCassetteChunk, error) {
	chunk := processCassetteChunk{
		ConnectionID: connectionID,
		ChunkSeq:     seq,
		ElapsedMS:    elapsed.Milliseconds(),
		Message:      frame.Message,
	}
	kinds := 0
	if len(frame.Stdout) > 0 {
		kinds++
		chunk.Kind = "stdout"
		chunk.Data = base64.StdEncoding.EncodeToString(frame.Stdout)
	}
	if len(frame.Stderr) > 0 {
		kinds++
		chunk.Kind = "stderr"
		chunk.Data = base64.StdEncoding.EncodeToString(frame.Stderr)
	}
	if frame.ExitCode != nil {
		kinds++
		chunk.Kind = "exit"
		exitCode := *frame.ExitCode
		chunk.ExitCode = &exitCode
	}
	if kinds != 1 {
		return processCassetteChunk{}, fmt.Errorf(
			"process frame must contain exactly one stdout, stderr, or exit payload; got %d",
			kinds,
		)
	}
	return chunk, nil
}

func decodeProcessCassetteFrame(chunk processCassetteChunk) (ProcessFrame, error) {
	frame := ProcessFrame{Message: chunk.Message}
	switch chunk.Kind {
	case "stdout":
		data, err := base64.StdEncoding.DecodeString(chunk.Data)
		if err != nil {
			return ProcessFrame{}, fmt.Errorf("decode stdout chunk %d: %w", chunk.ChunkSeq, err)
		}
		frame.Stdout = data
	case "stderr":
		data, err := base64.StdEncoding.DecodeString(chunk.Data)
		if err != nil {
			return ProcessFrame{}, fmt.Errorf("decode stderr chunk %d: %w", chunk.ChunkSeq, err)
		}
		frame.Stderr = data
	case "exit":
		if chunk.ExitCode == nil {
			return ProcessFrame{}, fmt.Errorf("exit chunk %d has no exit code", chunk.ChunkSeq)
		}
		exitCode := *chunk.ExitCode
		frame.ExitCode = &exitCode
	default:
		return ProcessFrame{}, fmt.Errorf("unsupported process cassette chunk kind %q", chunk.Kind)
	}
	return frame, nil
}
