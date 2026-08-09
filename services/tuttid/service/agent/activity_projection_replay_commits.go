package agent

import (
	"context"
	"log/slog"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

type ReplayCommitObserver interface {
	agenthost.CommitObserver
	ObserveReplayCommitted(
		context.Context,
		agenthost.CommittedDelta,
		replay.ProviderObservationCommitContext,
	) error
}

func (p *ActivityProjection) SetReplayCommitObserver(
	observer ReplayCommitObserver,
) {
	if p != nil {
		p.replayCommitObserver = observer
	}
}

func (p *ActivityProjection) notifyReplayCommitted(
	ctx context.Context,
	delta agenthost.CommittedDelta,
	replayContext replay.ProviderObservationCommitContext,
) {
	if p == nil || p.replayCommitObserver == nil ||
		len(replayContext.Batches) == 0 {
		return
	}
	if err := p.replayCommitObserver.ObserveReplayCommitted(
		ctx,
		delta,
		cloneReplayCommitContext(replayContext),
	); err != nil {
		slog.Warn(
			"agent Replay commit observer failed",
			"event",
			"agent_replay.commit_observer.failed",
			"transaction_id",
			delta.TransactionID,
			"error",
			err,
		)
	}
}

func cloneReplayCommitContext(
	context replay.ProviderObservationCommitContext,
) replay.ProviderObservationCommitContext {
	if len(context.Batches) == 0 {
		return replay.ProviderObservationCommitContext{}
	}
	out := replay.ProviderObservationCommitContext{
		RecordingID: context.RecordingID,
		Batches: make(
			[]replay.ProviderObservationBatch,
			len(context.Batches),
		),
	}
	for index, batch := range context.Batches {
		out.Batches[index] = batch
		out.Batches[index].Events = append(
			[]replay.ProviderObservationEvent(nil),
			batch.Events...,
		)
	}
	return out
}
