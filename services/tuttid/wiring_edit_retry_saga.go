//go:build tuttid_integration_test

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

const (
	integrationEditRetrySagaEnableEnv = "TUTTID_TEST_ENABLE_EDIT_RETRY_SAGA"
	integrationEditRetrySagaLedgerEnv = "TUTTID_TEST_EDIT_RETRY_MUTATION_LEDGER"
	integrationEditRetrySagaTraceEnv  = "TUTTID_TEST_EDIT_RETRY_TRACE"
	integrationEditRetrySagaSocketEnv = "TUTTID_TEST_EDIT_RETRY_SIDECAR_ADDR"
)

// enableEditRetrySagaForIntegration is compiled only into the integration
// child binary. Both the build tag and child marker are required, so ordinary
// production execution cannot opt into the disabled saga through an env var.
func enableEditRetrySagaForIntegration(
	current *agenthost.Host,
	support agentservice.HostSupportPorts,
	canonical agentservice.ApplicationHostCanonicalPorts,
	sessionForkRecovery agenthost.SessionForkRecoveryStore,
	historicalState agenthost.HistoricalSessionStateStore,
	runtime agentservice.ApplicationHostRuntime,
) *agenthost.Host {
	if os.Getenv(postListenerRecoveryTestChildEnv) != "1" ||
		os.Getenv(integrationEditRetrySagaEnableEnv) != "1" ||
		(strings.TrimSpace(os.Getenv(integrationEditRetrySagaLedgerEnv)) == "" &&
			strings.TrimSpace(os.Getenv(integrationEditRetrySagaSocketEnv)) == "") {
		return current
	}
	return agentservice.NewIntegrationApplicationHostWithEditRetryEnabled(
		support,
		canonical,
		sessionForkRecovery,
		historicalState,
		integrationEditRetrySagaRuntime{
			ApplicationHostRuntime: runtime,
			ledger:                 os.Getenv(integrationEditRetrySagaLedgerEnv),
			trace:                  os.Getenv(integrationEditRetrySagaTraceEnv),
			sidecarAddr:            strings.TrimSpace(os.Getenv(integrationEditRetrySagaSocketEnv)),
		},
	)
}

// This runtime is intentionally provider-neutral: the external ledger records
// an effect, then the provider reports an unknown outcome. It makes the daemon
// black box prove at-most-once automatic mutation and reconcile-only recovery.
// Embedded ports cover unrelated service paths; the enabled fixture reaches
// only the explicitly implemented edit-retry history methods.
type integrationEditRetrySagaRuntime struct {
	agentservice.ApplicationHostRuntime
	ledger      string
	trace       string
	sidecarAddr string
}

func (r integrationEditRetrySagaRuntime) ValidatePromptContent(context.Context, agenthost.RuntimeExecInput) error {
	return nil
}

func (r integrationEditRetrySagaRuntime) Session(workspaceID, sessionID string) (agenthost.ProviderRuntimeSession, bool) {
	_ = appendIntegrationEditRetryMutation(r.trace, "session:"+sessionID)
	return agenthost.ProviderRuntimeSession{
		ID:                sessionID,
		WorkspaceID:       workspaceID,
		Provider:          "codex",
		ProviderSessionID: "thread-" + sessionID,
		Resumable:         true,
	}, true
}

func (r integrationEditRetrySagaRuntime) Cancel(context.Context, agenthost.RuntimeCancelInput) (agenthost.RuntimeCancelResult, error) {
	return agenthost.RuntimeCancelResult{}, nil
}

func (r integrationEditRetrySagaRuntime) RuntimeSessionLive(workspaceID, sessionID string) bool {
	return true
}

func (r integrationEditRetrySagaRuntime) FenceGoalGeneration(ctx context.Context, input agenthost.RuntimeGoalGenerationFenceInput) error {
	fencer, ok := r.ApplicationHostRuntime.(agenthost.GoalRuntimeGenerationFencer)
	if !ok {
		return agenthost.ErrGoalGenerationFenceUnavailable
	}
	return fencer.FenceGoalGeneration(ctx, input)
}

func (r integrationEditRetrySagaRuntime) SupportsEffectiveHistory(context.Context, agenthost.RuntimeHistoryInput) (bool, error) {
	return true, nil
}

func (r integrationEditRetrySagaRuntime) ReadEffectiveHistory(_ context.Context, input agenthost.RuntimeHistoryInput) (agenthost.RuntimeHistorySnapshot, error) {
	_ = appendIntegrationEditRetryMutation(r.trace, "read:"+input.AgentSessionID)
	return agenthost.RuntimeHistorySnapshot{
		ProviderSessionID: "thread-" + input.AgentSessionID,
		Turns:             []agenthost.RuntimeHistoryTurn{{ID: "provider-" + input.AgentSessionID}},
	}, nil
}

func (r integrationEditRetrySagaRuntime) RollbackLatestTurn(ctx context.Context, input agenthost.RuntimeHistoryInput) (agenthost.RuntimeHistoryMutationResult, error) {
	_ = appendIntegrationEditRetryMutation(r.trace, "rollback")
	if r.sidecarAddr != "" {
		identity := "rollback:" + input.WorkspaceID + ":" + input.AgentSessionID
		if err := integrationEditRetrySidecarMutation(ctx, r.sidecarAddr, identity); err != nil {
			return agenthost.RuntimeHistoryMutationResult{Disposition: agenthost.RuntimeDispatchDispositionOutcomeUnknown}, fmt.Errorf("integration sidecar response lost: %w", err)
		}
		return agenthost.RuntimeHistoryMutationResult{Disposition: agenthost.RuntimeDispatchDispositionOutcomeUnknown}, errors.New("integration sidecar returned without a response")
	}
	if err := appendIntegrationEditRetryMutation(r.ledger, "rollback"); err != nil {
		return agenthost.RuntimeHistoryMutationResult{}, err
	}
	return agenthost.RuntimeHistoryMutationResult{Disposition: agenthost.RuntimeDispatchDispositionOutcomeUnknown}, errors.New("integration provider response lost")
}

func integrationEditRetrySidecarMutation(ctx context.Context, address, identity string) error {
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", address)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := fmt.Fprintf(conn, "ROLLBACK %s\n", identity); err != nil {
		return err
	}
	_, err = io.Copy(io.Discard, conn)
	return err
}

func appendIntegrationEditRetryMutation(path, mutation string) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.WriteString(mutation + "\n")
	return err
}
