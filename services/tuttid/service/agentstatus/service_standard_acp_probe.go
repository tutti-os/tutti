package agentstatus

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"os/exec"
	"strconv"
	"strings"
)

// standardACPHandshakeClientName identifies probe-originated `initialize`
// calls in agent logs, distinct from the real session client name (which
// lives in the runtime/session layer this detection package does not depend
// on).
const standardACPHandshakeClientName = "tutti-agent-status-probe"

const standardACPHandshakeProtocolVersion = 1

// newStandardACPHandshakeRequestID picks a fresh id in [2, 1000001] for each
// probe run, deliberately never 1. A binary that fakes ACP by always
// answering a canned, hardcoded response line (without actually reading and
// parsing our request from stdin) can otherwise "guess" a fixed id like 1
// for free; requiring the id to match a value generated at probe time
// forces it to genuinely round-trip the request. See Agent 可用性需求摘要 issue
// #1.
func newStandardACPHandshakeRequestID() int {
	return rand.IntN(1_000_000) + 2
}

// standardACPHandshakeResponse is the minimal shape this probe cares about
// from a Standard ACP agent's JSON-RPC line: enough to tell a real
// `initialize` response apart from a notification, a server-initiated
// request, or a reply to a different call.
type standardACPHandshakeResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Result  json.RawMessage `json:"result"`
	Error   *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// probeStandardACPHandshake replaces the generic "process stayed alive"
// liveness probe with a real ACP `initialize` JSON-RPC round trip, for
// providers whose CLI binary IS the ACP adapter (cursor-agent, opencode: both
// invoked as `<binary> acp`). A binary that starts but cannot actually serve
// ACP (incomplete install, network trouble during its own startup, a
// corrupted binary, ...) fails here instead of being reported as available.
// See Agent 可用性需求摘要 issue #1.
//
// This intentionally does not reuse the session-oriented ACP client in
// packages/agent/daemon/runtime (StandardACPAdapter / RunStandardACPSetup):
// that client is built for long-lived, stateful sessions (session/new,
// message routing, auth handling) which this one-shot detection probe does
// not need and should not depend on. The request shape below is a minimal,
// locally-defined subset of the real ACP `initialize` params, independent
// from probeCodexAppServerHandshake so the two probes cannot regress each
// other.
func (s Service) probeStandardACPHandshake(
	ctx context.Context,
	result ProbeResult,
	command []string,
	env []string,
) ProbeResult {
	if ctx == nil {
		ctx = context.Background()
	}
	probeCtx, cancel := context.WithTimeout(ctx, s.probeTimeout())
	defer cancel()

	cmd := exec.CommandContext(probeCtx, command[0], command[1:]...)
	cmd.Env = env
	cmd.WaitDelay = defaultProbeWaitDelay

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return standardACPHandshakeFailure(result, err.Error())
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return standardACPHandshakeFailure(result, err.Error())
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		return standardACPHandshakeFailure(result, err.Error())
	}

	requestID := newStandardACPHandshakeRequestID()

	responseCh := make(chan standardACPHandshakeResponse, 1)
	readDoneCh := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := bytes.TrimSpace(scanner.Bytes())
			if len(line) == 0 {
				continue
			}
			var response standardACPHandshakeResponse
			if err := json.Unmarshal(line, &response); err != nil {
				continue // stray non-JSON-RPC output; keep reading
			}
			if !isStandardACPHandshakeResponse(response, requestID) {
				continue // a notification (no id) or an empty frame, not our reply
			}
			responseCh <- response
			return
		}
		readDoneCh <- scanner.Err()
	}()

	requestPayload, marshalErr := json.Marshal(struct {
		JSONRPC string                      `json:"jsonrpc"`
		ID      int                         `json:"id"`
		Method  string                      `json:"method"`
		Params  standardACPInitializeParams `json:"params"`
	}{
		JSONRPC: "2.0",
		ID:      requestID,
		Method:  "initialize",
		Params: standardACPInitializeParams{
			ProtocolVersion: standardACPHandshakeProtocolVersion,
			ClientCapabilities: standardACPClientCapabilities{
				Meta: standardACPClientCapabilitiesMeta{TerminalOutput: true},
			},
			ClientInfo: standardACPClientInfo{Name: standardACPHandshakeClientName, Version: "0.0.0"},
		},
	})

	var handshakeErr error
	if marshalErr != nil {
		handshakeErr = marshalErr
	} else if _, writeErr := stdin.Write(append(requestPayload, '\n')); writeErr != nil {
		handshakeErr = fmt.Errorf("write initialize request to acp adapter: %w", writeErr)
	} else {
		select {
		case response := <-responseCh:
			if response.Error != nil {
				handshakeErr = fmt.Errorf("acp adapter rejected initialize: %s", response.Error.Message)
			}
		case readErr := <-readDoneCh:
			if readErr != nil {
				handshakeErr = readErr
			} else {
				handshakeErr = errors.New("acp adapter exited before responding to initialize")
			}
		case <-probeCtx.Done():
			handshakeErr = errors.New("acp adapter did not respond to initialize before the probe timed out")
		}
	}

	_ = stdin.Close()
	cancel()
	_ = cmd.Wait()

	if handshakeErr != nil {
		return standardACPHandshakeFailure(result, firstNonBlank(trimProbeOutput(stderr.String()), handshakeErr.Error()))
	}
	result.Status = ProbeReady
	return result
}

// standardACPInitializeParams is a minimal, locally-defined subset of the
// real ACP `initialize` request params (see
// packages/agent/daemon/runtime/standard_acp_events.go's
// defaultACPInitializeParams), just enough to get a well-formed agent to
// respond. It intentionally does not import that package.
type standardACPInitializeParams struct {
	ProtocolVersion    int                           `json:"protocolVersion"`
	ClientCapabilities standardACPClientCapabilities `json:"clientCapabilities"`
	ClientInfo         standardACPClientInfo         `json:"clientInfo"`
}

type standardACPClientCapabilities struct {
	FS       standardACPFSCapability           `json:"fs"`
	Terminal bool                              `json:"terminal"`
	Meta     standardACPClientCapabilitiesMeta `json:"_meta"`
}

type standardACPFSCapability struct {
	ReadTextFile  bool `json:"readTextFile"`
	WriteTextFile bool `json:"writeTextFile"`
}

type standardACPClientCapabilitiesMeta struct {
	TerminalOutput bool `json:"terminal_output"`
}

type standardACPClientInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

func standardACPHandshakeFailure(result ProbeResult, message string) ProbeResult {
	result.Status = ProbeFailed
	result.ReasonCode = "acp_adapter_launch_failed"
	result.Message = message
	return result
}

// isStandardACPHandshakeResponse reports whether response is a genuine
// reply to this probe's own `initialize` call, as opposed to a
// notification, a server-initiated request, or a reply to some other
// (unmatched) call. A binary that fakes ACP by echoing an unrelated or
// malformed JSON-RPC line (wrong id, missing "jsonrpc", or a bare
// {"method":...} request) must not be able to satisfy this check. wantID is
// the id this probe run generated for its own request (see
// newStandardACPHandshakeRequestID); a hardcoded/canned response that never
// reads stdin cannot know it in advance.
func isStandardACPHandshakeResponse(response standardACPHandshakeResponse, wantID int) bool {
	if response.JSONRPC != "2.0" {
		return false
	}
	if response.Method != "" {
		return false // a server-initiated request, not a reply to our call
	}
	id, ok := standardACPHandshakeResponseID(response.ID)
	if !ok || id != wantID {
		return false
	}
	if response.Error != nil {
		return true
	}
	trimmedResult := bytes.TrimSpace(response.Result)
	return len(trimmedResult) > 0 && !bytes.Equal(trimmedResult, []byte("null"))
}

// standardACPHandshakeResponseID parses a JSON-RPC id, accepting both the
// number and string encodings the spec allows.
func standardACPHandshakeResponseID(raw json.RawMessage) (int, bool) {
	var number int
	if err := json.Unmarshal(raw, &number); err == nil {
		return number, true
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		if parsed, err := strconv.Atoi(strings.TrimSpace(text)); err == nil {
			return parsed, true
		}
	}
	return 0, false
}
