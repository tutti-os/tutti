package agentruntime

import (
	"context"
	"errors"
	"io"
	"time"
)

func (c *replayProcessConnection) Recv() (ProcessFrame, error) {
	return c.recvContext(context.Background())
}

func (c *replayProcessConnection) RecvContext(ctx context.Context) (ProcessFrame, error) {
	return c.recvContext(ctx)
}

func (c *replayProcessConnection) recvContext(ctx context.Context) (ProcessFrame, error) {
	c.recvMu.Lock()
	defer c.recvMu.Unlock()
	for {
		c.mu.Lock()
		if c.isClosedLocked() {
			c.mu.Unlock()
			return ProcessFrame{}, io.EOF
		}
		if len(c.pendingSyntheticStdout) > 0 {
			stdout := c.pendingSyntheticStdout[0]
			c.pendingSyntheticStdout = c.pendingSyntheticStdout[1:]
			connectionID := c.connectionID
			c.mu.Unlock()
			return ProcessFrame{
				Stdout:       stdout,
				ConnectionID: connectionID,
				Synthetic:    true,
			}, nil
		}
		if c.cursor >= len(c.chunks) {
			if c.holdOpen {
				changed := c.changed
				c.mu.Unlock()
				select {
				case <-ctx.Done():
					return ProcessFrame{}, ctx.Err()
				case <-changed:
				}
				continue
			}
			c.mu.Unlock()
			return ProcessFrame{}, io.EOF
		}
		chunk := c.chunks[c.cursor]
		if chunk.Kind == "outbound" {
			if method, responseID, ok := processCassetteJSONRPCRequest(chunk); ok &&
				responseID != "" && c.descriptor.IsOptionalProbeMethod(method) {
				if !c.skippingOptionalProbeRun {
					changed := c.changed
					c.mu.Unlock()
					timer := time.NewTimer(50 * time.Millisecond)
					select {
					case <-ctx.Done():
						stopReplayPlaybackTimer(timer)
						return ProcessFrame{}, ctx.Err()
					case <-c.closed:
						stopReplayPlaybackTimer(timer)
						return ProcessFrame{}, io.EOF
					case <-changed:
						stopReplayPlaybackTimer(timer)
						continue
					case <-timer.C:
					}
					c.mu.Lock()
					if c.cursor >= len(c.chunks) ||
						c.chunks[c.cursor].ChunkSeq != chunk.ChunkSeq {
						c.mu.Unlock()
						continue
					}
				}
				c.playback.advanceTo(chunk.ElapsedMS)
				c.skippedRPCs[responseID] = struct{}{}
				c.skippingOptionalProbeRun = true
				c.cursor++
				c.signalChangedLocked()
				c.mu.Unlock()
				continue
			}
			changed := c.changed
			c.mu.Unlock()
			select {
			case <-ctx.Done():
				return ProcessFrame{}, ctx.Err()
			case <-changed:
			}
			continue
		}
		// Inbound delivery may park on checkpoint pause. Optional-probe absorb
		// queues synthetic stdout and signals c.changed; interrupt those waits so
		// Recv can drain the synthetic response without waiting for the fence.
		chunkSeq := chunk.ChunkSeq
		elapsedMS := chunk.ElapsedMS
		for {
			if len(c.pendingSyntheticStdout) > 0 {
				c.mu.Unlock()
				break
			}
			if c.cursor >= len(c.chunks) || c.chunks[c.cursor].ChunkSeq != chunkSeq {
				c.mu.Unlock()
				break
			}
			connChanged := c.changed
			c.mu.Unlock()
			if err := c.playback.waitUntil(ctx, elapsedMS, c.closed, connChanged); err != nil {
				if errors.Is(err, errReplayRecvInterrupted) {
					c.mu.Lock()
					continue
				}
				if errors.Is(err, context.Canceled) && c.isClosed() {
					return ProcessFrame{}, io.EOF
				}
				return ProcessFrame{}, err
			}
			c.mu.Lock()
			if len(c.pendingSyntheticStdout) > 0 {
				c.mu.Unlock()
				break
			}
			if c.cursor >= len(c.chunks) || c.chunks[c.cursor].ChunkSeq != chunkSeq {
				c.mu.Unlock()
				break
			}
			connChanged = c.changed
			c.mu.Unlock()
			endRelease, err := c.playback.controller.beginInboundRelease(ctx, c.closed, connChanged)
			if err != nil {
				if errors.Is(err, errReplayRecvInterrupted) {
					c.mu.Lock()
					continue
				}
				if errors.Is(err, context.Canceled) && c.isClosed() {
					return ProcessFrame{}, io.EOF
				}
				return ProcessFrame{}, err
			}
			c.mu.Lock()
			if c.isClosedLocked() {
				c.mu.Unlock()
				endRelease()
				return ProcessFrame{}, io.EOF
			}
			if len(c.pendingSyntheticStdout) > 0 ||
				c.cursor >= len(c.chunks) ||
				c.chunks[c.cursor].ChunkSeq != chunkSeq {
				c.mu.Unlock()
				endRelease()
				break
			}
			frame, err := decodeProcessCassetteFrame(chunk)
			if err != nil {
				c.mu.Unlock()
				endRelease()
				return ProcessFrame{}, err
			}
			frame.Stdout = mapProcessCassetteFrameJSON(
				frame.Stdout,
				c.recordedCWD,
				c.replayCWD,
				c.replayHome,
				c.descriptor,
				c.identityValues,
			)
			frame.Stderr = mapProcessCassetteFrameJSON(
				frame.Stderr,
				c.recordedCWD,
				c.replayCWD,
				c.replayHome,
				c.descriptor,
				c.identityValues,
			)
			frame.Stdout = suppressSkippedProcessCassetteResponses(frame.Stdout, c.skippedRPCs)
			frame.Stdout = mapProcessCassetteResponseIDs(frame.Stdout, c.responseIDs)
			frame.ConnectionID = chunk.ConnectionID
			frame.ChunkSeq = chunk.ChunkSeq
			c.cursor++
			c.signalChangedLocked()
			c.mu.Unlock()
			endRelease()
			if len(frame.Stdout) == 0 && len(frame.Stderr) == 0 &&
				frame.ExitCode == nil && frame.Message == "" {
				break
			}
			c.mu.Lock()
			c.skippingOptionalProbeRun = false
			c.mu.Unlock()
			return frame, nil
		}
		continue
	}
}
