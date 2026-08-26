package agentruntime

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	sessionreplay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

func (c *acpClient) readLoop() {
	var pending []byte
	var stderrTail []byte
	var stdoutTail []byte
	for {
		frame, err := c.conn.Recv()
		if err != nil {
			c.finish(err)
			return
		}
		if len(frame.Stderr) > 0 {
			stderrTail = append(stderrTail, frame.Stderr...)
			if len(stderrTail) > acpClientOutputTailLimit {
				stderrTail = stderrTail[len(stderrTail)-acpClientOutputTailLimit:]
			}
			c.setStderrTail(stderrTail)
			c.mu.Lock()
			stderrSink := c.stderrSink
			c.mu.Unlock()
			if stderrSink != nil {
				stderrSink(frame.Stderr)
			}
			if c.stderrMessageMapper != nil {
				if message, ok := c.stderrMessageMapper(frame.Stderr); ok {
					unit := providerInputUnit(
						frame,
						1,
						sessionreplay.ProviderInputUnitMappedStderr,
					)
					c.dispatchMessageAt(message, &unit)
					if err := c.completeProviderInputUnit(
						frame,
						1,
						sessionreplay.ProviderInputUnitMappedStderr,
					); err != nil {
						c.finish(err)
						return
					}
				}
			}
			// Provider stderr is already retained in the startup trace and the
			// bounded diagnostics tail. It is normal for providers to emit many
			// small stderr frames, so keep this duplicate diagnostic off the
			// default warning log path.
			slog.Debug("agent session ACP stderr",
				"event", "agent_session.acp.stderr",
				"message", truncateACPLogValue(string(frame.Stderr), 1200),
			)
			continue
		}
		if frame.ExitCode != nil {
			unit := providerInputUnit(
				frame,
				1,
				sessionreplay.ProviderInputUnitProcessExit,
			)
			if err := c.completeProviderInputUnit(
				frame,
				1,
				sessionreplay.ProviderInputUnitProcessExit,
			); err != nil {
				c.finish(err)
				return
			}
			c.setExitCode(*frame.ExitCode)
			message := strings.TrimSpace(frame.Message)
			if stderr := strings.TrimSpace(string(stderrTail)); stderr != "" {
				message = firstNonEmpty(message, "process exited") + ": " + stderr
			}
			c.finish(providerInputUnitError{
				err: fmt.Errorf(
					"acp process exited with code %d: %s",
					*frame.ExitCode,
					message,
				),
				unit: unit,
			})
			return
		}
		if len(frame.Stdout) == 0 {
			continue
		}
		stdoutTail = append(stdoutTail, frame.Stdout...)
		if len(stdoutTail) > acpClientOutputTailLimit {
			stdoutTail = stdoutTail[len(stdoutTail)-acpClientOutputTailLimit:]
		}
		c.setStdoutTail(stdoutTail)
		pending = append(pending, frame.Stdout...)
		// Synthetic optional-probe / startup-metadata responses are not cassette
		// units. Completing them would report ChunkSeq=0 and trip the provider
		// input barrier's "position moved backward" guard after real frames.
		if frame.Synthetic {
			for {
				line, rest, ok := bytes.Cut(pending, []byte("\n"))
				if !ok {
					break
				}
				pending = rest
				c.dispatchLine(line)
			}
			continue
		}
		var unitIndex uint64
		for {
			line, rest, ok := bytes.Cut(pending, []byte("\n"))
			if !ok {
				break
			}
			pending = rest
			nextUnitIndex := unitIndex + 1
			if !c.dispatchLineAt(line, frame, nextUnitIndex) {
				continue
			}
			unitIndex = nextUnitIndex
			for {
				err := c.completeProviderInputUnit(
					frame,
					unitIndex,
					sessionreplay.ProviderInputUnitProtocolMessage,
				)
				if errors.Is(err, errReplaySyntheticPending) {
					if drainErr := c.drainSyntheticOptionalProbeResponses(); drainErr != nil {
						c.finish(drainErr)
						return
					}
					continue
				}
				if err != nil {
					c.finish(err)
					return
				}
				break
			}
		}
	}
}

func (c *acpClient) drainSyntheticOptionalProbeResponses() error {
	replayConn, ok := c.conn.(interface{ HasPendingSyntheticStdout() bool })
	if !ok {
		return nil
	}
	for replayConn.HasPendingSyntheticStdout() {
		frame, err := c.conn.Recv()
		if err != nil {
			return err
		}
		if len(frame.Stdout) == 0 {
			continue
		}
		pending := append([]byte(nil), frame.Stdout...)
		for {
			line, rest, cut := bytes.Cut(pending, []byte("\n"))
			if !cut {
				break
			}
			pending = rest
			c.dispatchLine(line)
		}
	}
	return nil
}

func (c *acpClient) completeProviderInputUnit(
	frame ProcessFrame,
	unitIndex uint64,
	kind sessionreplay.ProviderInputUnitKind,
) error {
	completion, ok := c.conn.(ProviderInputUnitCompletion)
	if !ok {
		return nil
	}
	return completion.CompleteProviderInputUnit(
		context.Background(),
		ProviderInputUnit{
			RecordingID: frame.RecordingID,
			Position: sessionreplay.ProviderUnitPosition{
				ConnectionID: frame.ConnectionID,
				ChunkSeq:     frame.ChunkSeq,
				UnitIndex:    unitIndex,
			},
			Kind: kind,
		},
	)
}
