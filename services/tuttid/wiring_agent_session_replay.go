package main

import (
	"context"
	"log/slog"

	agentdaemon "github.com/tutti-os/tutti/packages/agent/daemon"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	tuttiapi "github.com/tutti-os/tutti/services/tuttid/api"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	replaydata "github.com/tutti-os/tutti/services/tuttid/data/agentsessionreplay"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	replayservice "github.com/tutti-os/tutti/services/tuttid/service/agentsessionreplay"
)

const agentSessionReplayLocalUserID = "tutti-local-user"

func resolveAgentSessionRecordingEnabled(
	ctx context.Context,
	preferences interface {
		Get(context.Context) (preferencesbiz.DesktopPreferences, error)
	},
) bool {
	desktopPreferences, err := preferences.Get(ctx)
	if err != nil {
		slog.WarnContext(
			ctx,
			"resolve agent session recording feature flag failed",
			"event", "agent_session_recording.feature_flag.resolve_failed",
			"error", err,
		)
		return false
	}
	return preferencesbiz.IsCapabilityFlagEnabled(
		desktopPreferences.FeatureFlags,
		preferencesbiz.FeatureFlagAgentSessionRecording,
	)
}

func composeAgentReplayVerifier(
	transport *agentdaemon.SessionReplayProcessTransport,
	semanticRuntime *replayservice.SemanticRuntime,
) tuttiapi.AgentSessionReplayVerifier {
	if transport == nil || semanticRuntime == nil {
		return nil
	}
	return agentReplayTransportVerifier{
		enabled:     true,
		transport:   transport,
		verifyState: semanticRuntime.Verify,
		verifyCheckpoint: func(
			ctx context.Context,
			cassetteID string,
			checkpointIndex int,
		) (tuttiapi.AgentSessionReplayCheckpointState, error) {
			// Fold the transport barrier's completed units into the semantic
			// handled lane before verify. Observation stamps can miss a unit
			// (compact slash-command path); the barrier still knows the unit
			// completed because it parks there.
			if handled, err := transport.ReplayProviderCursor(cassetteID); err == nil {
				semanticRuntime.NoteHandledProviderUnits(cassetteID, handled)
			}
			state, err := semanticRuntime.VerifyCheckpoint(
				ctx,
				cassetteID,
				checkpointIndex,
			)
			return tuttiapi.AgentSessionReplayCheckpointState{
				TriggerMatched:                  state.TriggerMatched,
				ReadinessSatisfied:              state.ReadinessSatisfied,
				CanonicalSessionUpdatedAtUnixMS: state.CanonicalSessionUpdatedAtUnixMS,
				CanonicalMessageVersion:         state.CanonicalMessageVersion,
			}, err
		},
	}
}

func prepareReplaySemanticRuntime(
	ctx context.Context,
	store *workspacedata.SQLiteStore,
	host *agenthost.Host,
	registrations []agentSessionReplayRegistration,
) (*replayservice.SemanticRuntime, error) {
	artifactDirectories := make(map[string]string, len(registrations))
	semanticRegistrations := make(
		[]replayservice.SemanticRegistration,
		0,
		len(registrations),
	)
	for _, registration := range registrations {
		artifactDirectories[registration.CassetteID] = registration.ArtifactDirectory
		semanticRegistrations = append(
			semanticRegistrations,
			replayservice.SemanticRegistration{
				CassetteID:    registration.CassetteID,
				RootSessionID: registration.RootAgentSessionID,
				WorkspaceID:   registration.WorkspaceID,
				UserID:        agentSessionReplayLocalUserID,
				Profile:       replayservice.TuttiSemanticProfile(),
			},
		)
	}
	reader, err := replaydata.NewSemanticCassetteReader(artifactDirectories)
	if err != nil {
		return nil, err
	}
	return replayservice.PrepareSemanticRuntime(
		ctx,
		store,
		host,
		reader,
		semanticRegistrations,
	)
}
