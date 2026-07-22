package agentruntime

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

const (
	maxPendingGoalTurnNotifications = 512
	maxPendingGoalTurns             = 16
	maxGoalTurnFingerprints         = 8
	maxGoalTurnEvidence             = 256
	maxGoalGenerationBindings       = 256
	goalReconcileDurableAckTimeout  = 2 * time.Second
	goalProvenanceDurableAckTimeout = 2 * time.Second
)

type codexGoalGenerationBinding struct {
	identity  goalOperationIdentity
	ambiguous bool
}

type codexGoalTurnEvidence struct {
	fingerprints   map[string]struct{}
	identity       goalOperationIdentity
	bound          bool
	ambiguous      bool
	lookupInFlight int
}

type codexPendingGoalTurn struct {
	providerTurnID string
	session        Session
	notifications  []acpMessage
	state          string
	provenanceMode string
}

const (
	codexGoalTurnPending  = "pending"
	codexGoalTurnAdopting = "adopting"
	codexGoalTurnAborting = "aborting"
	codexGoalTurnRejected = "rejected"
)

func appServerNotificationProviderTurnID(params map[string]any) string {
	return firstNonEmpty(
		strings.TrimSpace(asString(params["turnId"])),
		strings.TrimSpace(asString(payloadObject(params["turn"])["id"])),
	)
}

func (identity goalOperationIdentity) valid() bool {
	return strings.TrimSpace(identity.operationID) != "" && identity.revision > 0
}

// codexGoalGenerationFingerprint intentionally uses only provider-authored
// generation fields that are present in both ThreadGoalSetResponse.Goal and
// ThreadGoalUpdatedNotification.Goal. A collision is not resolved by arrival
// order: bindGoalGeneration marks it ambiguous and no Turn receives either
// durable identity.
func codexGoalGenerationFingerprint(goal map[string]any) string {
	threadID := strings.TrimSpace(asString(goal["threadId"]))
	objective := strings.TrimSpace(asStringRaw(goal["objective"]))
	createdAt, createdOK := int64Value(goal["createdAt"])
	updatedAt, updatedOK := int64Value(goal["updatedAt"])
	if threadID == "" || objective == "" || !createdOK || !updatedOK || createdAt <= 0 || updatedAt <= 0 {
		return ""
	}
	canonical := fmt.Sprintf("thread=%q;created=%d;updated=%d;objective=%q", threadID, createdAt, updatedAt, objective)
	digest := sha256.Sum256([]byte(canonical))
	return fmt.Sprintf("sha256:%x", digest)
}

// bindGoalGeneration records evidence from a successful durable Goal RPC.
// It never rewrites an existing generation association. If the provider
// reuses the same observable generation for two durable operations, that
// generation becomes permanently ambiguous instead of choosing the latest.
func (a *CodexAppServerAdapter) bindGoalGeneration(_ context.Context, session Session, goal map[string]any, identity goalOperationIdentity) error {
	if a == nil {
		return errors.New("goal provenance adapter is unavailable")
	}
	if !identity.valid() {
		// Legacy slash-goal and status-only provider paths do not carry a
		// durable business operation identity and therefore cannot establish a
		// Goal-to-Turn association. Preserve their existing behavior; the
		// fail-closed fingerprint requirement applies when a valid durable
		// operation is being bound.
		return nil
	}
	fingerprint := codexGoalGenerationFingerprint(goal)
	if fingerprint == "" {
		err := errors.New("provider goal generation is missing immutable fingerprint fields")
		a.failGoalProvenanceSession(session, err)
		return err
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	a.mu.Lock()
	appSession := a.sessions[agentSessionID]
	if appSession == nil {
		a.mu.Unlock()
		return nil
	}
	if appSession.provenanceDegraded {
		a.mu.Unlock()
		return errors.New("goal provenance session is degraded")
	}
	threadID := appSession.threadID
	sink := a.goalProvenanceSink
	a.mu.Unlock()
	// The session-level app-server handler is installed before thread/start
	// returns, so its captured Session may not yet contain the provider thread
	// id. The live registry is authoritative for the durable ledger key.
	session.ProviderSessionID = threadID

	binding := codexGoalGenerationBinding{identity: identity}
	if sink != nil {
		ackCtx, cancel := context.WithTimeout(context.Background(), goalProvenanceDurableAckTimeout)
		durable, err := sink.BindGoalProvenance(ackCtx, session, fingerprint, GoalProvenanceBinding{
			OperationID: identity.operationID,
			Revision:    identity.revision,
			RepairEpoch: identity.repairEpoch,
		})
		cancel()
		if err != nil {
			a.failGoalProvenanceSession(session, fmt.Errorf("persist goal provenance binding: %w", err))
			return err
		}
		if durable.Ambiguous {
			err := errors.New("provider goal generation fingerprint is permanently ambiguous")
			a.failGoalProvenanceSession(session, err)
			return err
		}
		binding = codexGoalGenerationBinding{
			identity: goalOperationIdentity{
				operationID: durable.OperationID,
				revision:    durable.Revision,
				repairEpoch: durable.RepairEpoch,
			},
			ambiguous: durable.Ambiguous,
		}
	}

	a.mu.Lock()
	appSession = a.sessions[agentSessionID]
	if appSession == nil || appSession.threadID != threadID || appSession.provenanceDegraded {
		a.mu.Unlock()
		return nil
	}
	if sink == nil {
		existing, found := appSession.goalGenerationBindings[fingerprint]
		switch {
		case !found:
		case existing.ambiguous:
			binding = existing
		case existing.identity != identity:
			binding.ambiguous = true
			binding.identity = goalOperationIdentity{}
		}
	}
	rememberGoalGenerationBindingLocked(appSession, fingerprint, binding)
	current := goalOperationIdentity{
		operationID: appSession.goalOperationID,
		revision:    appSession.goalRevision,
		repairEpoch: appSession.goalRepairEpoch,
	}
	if current == identity && !binding.ambiguous && binding.identity == identity {
		appSession.currentGoalGenerationFingerprint = fingerprint
	}
	a.pruneGoalProvenanceLocked(appSession)
	pendingTurnIDs := make([]string, 0, len(appSession.pendingGoalTurns))
	for providerTurnID := range appSession.pendingGoalTurns {
		pendingTurnIDs = append(pendingTurnIDs, providerTurnID)
	}
	a.mu.Unlock()
	for _, providerTurnID := range pendingTurnIDs {
		a.tryResolvePendingGoalTurn(agentSessionID, providerTurnID)
	}
	return nil
}

// observeGoalTurnGeneration consumes exact turn-scoped Goal provenance from
// ThreadGoalUpdatedNotification.turnId + goal snapshot. turn/started alone is
// deliberately insufficient; the compatibility path additionally requires a
// single-use claim established by a successful ordered Goal mutation.
func (a *CodexAppServerAdapter) observeGoalTurnGeneration(session Session, providerTurnID string, goal map[string]any) {
	providerTurnID = strings.TrimSpace(providerTurnID)
	fingerprint := codexGoalGenerationFingerprint(goal)
	if a == nil || providerTurnID == "" {
		return
	}
	if fingerprint == "" {
		a.failGoalProvenanceSession(session, errors.New("turn-scoped provider goal generation is missing immutable fingerprint fields"))
		return
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	a.mu.Lock()
	appSession := a.sessions[agentSessionID]
	if appSession == nil {
		a.mu.Unlock()
		return
	}
	if appSession.provenanceDegraded {
		a.mu.Unlock()
		return
	}
	if appSession.goalTurnEvidence == nil {
		appSession.goalTurnEvidence = make(map[string]*codexGoalTurnEvidence)
	}
	evidence := appSession.goalTurnEvidence[providerTurnID]
	if evidence == nil {
		if len(appSession.goalTurnEvidence) >= maxGoalTurnEvidence {
			pending := a.degradeGoalProvenanceLocked(appSession)
			a.mu.Unlock()
			a.quiesceDegradedGoalTurns(pending, "goal turn provenance capacity exceeded")
			return
		}
		evidence = &codexGoalTurnEvidence{fingerprints: make(map[string]struct{})}
		appSession.goalTurnEvidence[providerTurnID] = evidence
	}
	if !evidence.bound && !evidence.ambiguous {
		_, exists := evidence.fingerprints[fingerprint]
		if !exists && len(evidence.fingerprints) >= maxGoalTurnFingerprints {
			evidence.ambiguous = true
			pending := a.degradeGoalProvenanceLocked(appSession)
			a.mu.Unlock()
			a.quiesceDegradedGoalTurns(pending, "goal turn provenance ambiguity exceeded")
			return
		}
		evidence.fingerprints[fingerprint] = struct{}{}
	}
	sink := a.goalProvenanceSink
	threadID := appSession.threadID
	if sink != nil {
		evidence.lookupInFlight++
	}
	a.mu.Unlock()
	session.ProviderSessionID = threadID

	if sink != nil {
		ackCtx, cancel := context.WithTimeout(context.Background(), goalProvenanceDurableAckTimeout)
		durable, found, err := sink.LookupGoalProvenance(ackCtx, session, fingerprint)
		cancel()
		if err != nil {
			a.failGoalProvenanceSession(session, fmt.Errorf("lookup goal provenance binding: %w", err))
			return
		}
		if found {
			a.mu.Lock()
			appSession = a.sessions[agentSessionID]
			if appSession == nil || appSession.threadID != threadID || appSession.provenanceDegraded {
				a.mu.Unlock()
				return
			}
			rememberGoalGenerationBindingLocked(appSession, fingerprint, codexGoalGenerationBinding{
				identity:  goalOperationIdentity{operationID: durable.OperationID, revision: durable.Revision, repairEpoch: durable.RepairEpoch},
				ambiguous: durable.Ambiguous,
			})
			a.mu.Unlock()
		}
	}

	a.mu.Lock()
	appSession = a.sessions[agentSessionID]
	if appSession == nil || appSession.threadID != threadID || appSession.provenanceDegraded {
		a.mu.Unlock()
		return
	}
	evidence = appSession.goalTurnEvidence[providerTurnID]
	if evidence != nil && sink != nil && evidence.lookupInFlight > 0 {
		evidence.lookupInFlight--
	}
	a.resolveGoalTurnEvidenceLocked(appSession, evidence)
	a.pruneGoalProvenanceLocked(appSession)
	a.mu.Unlock()
	a.tryResolvePendingGoalTurn(agentSessionID, providerTurnID)
}

func (*CodexAppServerAdapter) resolveGoalTurnEvidenceLocked(appSession *codexAppServerSession, evidence *codexGoalTurnEvidence) {
	if appSession == nil || evidence == nil || evidence.bound || evidence.ambiguous {
		return
	}
	candidate := goalOperationIdentity{}
	for fingerprint := range evidence.fingerprints {
		binding, ok := appSession.goalGenerationBindings[fingerprint]
		if !ok || binding.ambiguous || !binding.identity.valid() {
			continue
		}
		if !candidate.valid() {
			candidate = binding.identity
			continue
		}
		if candidate != binding.identity {
			evidence.ambiguous = true
			evidence.identity = goalOperationIdentity{}
			return
		}
	}
	if candidate.valid() {
		evidence.identity = candidate
		evidence.bound = true
	}
}

func (a *CodexAppServerAdapter) queueGoalTurnForProvenance(session Session, providerTurnID string) {
	providerTurnID = strings.TrimSpace(providerTurnID)
	if a == nil || providerTurnID == "" {
		return
	}
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	if appSession == nil || appSession.activeTurn != nil {
		a.mu.Unlock()
		return
	}
	if appSession.provenanceDegraded {
		a.mu.Unlock()
		a.quiesceUnprovenGoalTurn(session, providerTurnID, "goal provenance session degraded")
		return
	}
	if appSession.pendingGoalTurns == nil {
		appSession.pendingGoalTurns = make(map[string]*codexPendingGoalTurn)
	}
	if _, exists := appSession.pendingGoalTurns[providerTurnID]; exists {
		a.mu.Unlock()
		return
	}
	if len(appSession.pendingGoalTurns) >= maxPendingGoalTurns {
		pending := a.degradeGoalProvenanceLocked(appSession)
		a.mu.Unlock()
		a.quiesceDegradedGoalTurns(pending, "goal provenance pending capacity exceeded")
		a.quiesceUnprovenGoalTurn(session, providerTurnID, "goal provenance pending capacity exceeded")
		return
	}
	appSession.pendingGoalTurns[providerTurnID] = &codexPendingGoalTurn{providerTurnID: providerTurnID, session: session, state: codexGoalTurnPending}
	grace := a.goalProvenanceGraceWindow
	if grace <= 0 {
		grace = defaultCodexAppServerGoalProvenanceGraceWindow
	}
	a.mu.Unlock()

	if a.tryResolvePendingGoalTurn(session.AgentSessionID, providerTurnID) {
		return
	}
	a.schedulePendingGoalTurnExpiry(session.AgentSessionID, providerTurnID, grace)
}

func (a *CodexAppServerAdapter) schedulePendingGoalTurnExpiry(agentSessionID, providerTurnID string, grace time.Duration) {
	go func() {
		timer := time.NewTimer(grace)
		defer timer.Stop()
		select {
		case <-timer.C:
			a.expirePendingGoalTurn(agentSessionID, providerTurnID)
		case <-a.sessionClientDone(agentSessionID):
		}
	}()
}

// pruneGoalProvenanceLocked bounds long-lived sessions without evicting any
// generation/evidence still needed by a pending or active provider Turn.
// Eviction is conservative: losing old evidence only causes a future delayed
// turn to be quiesced; it can never make that turn inherit a newer identity.
func (*CodexAppServerAdapter) pruneGoalProvenanceLocked(appSession *codexAppServerSession) {
	if appSession == nil {
		return
	}
	protectedFingerprints := make(map[string]struct{})
	currentIdentity := goalOperationIdentity{
		operationID: appSession.goalOperationID,
		revision:    appSession.goalRevision,
		repairEpoch: appSession.goalRepairEpoch,
	}
	if fingerprint := strings.TrimSpace(appSession.currentGoalGenerationFingerprint); currentIdentity.valid() && fingerprint != "" {
		if binding, ok := appSession.goalGenerationBindings[fingerprint]; ok && !binding.ambiguous && binding.identity == currentIdentity {
			protectedFingerprints[fingerprint] = struct{}{}
		}
	}
	// Keep every unmatched or live Turn's small evidence set. Settled and
	// rejected turns remove their evidence explicitly, so this working set is
	// bounded independently of how many Goal generations the session has seen.
	for _, evidence := range appSession.goalTurnEvidence {
		if evidence != nil {
			for fingerprint := range evidence.fingerprints {
				protectedFingerprints[fingerprint] = struct{}{}
			}
		}
	}
	retainedOrder := make([]string, 0, len(appSession.goalGenerationOrder))
	for _, fingerprint := range appSession.goalGenerationOrder {
		if _, exists := appSession.goalGenerationBindings[fingerprint]; !exists {
			continue
		}
		if len(appSession.goalGenerationBindings) > maxGoalGenerationBindings {
			if _, protected := protectedFingerprints[fingerprint]; !protected {
				delete(appSession.goalGenerationBindings, fingerprint)
				continue
			}
		}
		retainedOrder = append(retainedOrder, fingerprint)
	}
	appSession.goalGenerationOrder = retainedOrder
}

func rememberGoalGenerationBindingLocked(appSession *codexAppServerSession, fingerprint string, binding codexGoalGenerationBinding) {
	if appSession == nil || strings.TrimSpace(fingerprint) == "" {
		return
	}
	if appSession.goalGenerationBindings == nil {
		appSession.goalGenerationBindings = make(map[string]codexGoalGenerationBinding)
	}
	if _, exists := appSession.goalGenerationBindings[fingerprint]; !exists {
		appSession.goalGenerationOrder = append(appSession.goalGenerationOrder, fingerprint)
	}
	appSession.goalGenerationBindings[fingerprint] = binding
}

func (a *CodexAppServerAdapter) failGoalProvenanceSession(session Session, cause error) {
	if a == nil {
		return
	}
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	if appSession == nil {
		a.mu.Unlock()
		return
	}
	pending := a.degradeGoalProvenanceLocked(appSession)
	client := appSession.client
	a.mu.Unlock()
	slog.Error("agent session app-server durable goal provenance unavailable",
		"event", "agent_session.app_server.goal.provenance_durable_unavailable",
		"agent_session_id", session.AgentSessionID,
		"error", cause,
	)
	a.quiesceDegradedGoalTurns(pending, cause.Error())
	if client != nil {
		go func() { _ = client.Close() }()
	}
}

func (*CodexAppServerAdapter) degradeGoalProvenanceLocked(appSession *codexAppServerSession) []codexPendingGoalTurn {
	if appSession == nil || appSession.provenanceDegraded {
		return nil
	}
	appSession.provenanceDegraded = true
	pending := make([]codexPendingGoalTurn, 0, len(appSession.pendingGoalTurns))
	for _, turn := range appSession.pendingGoalTurns {
		if turn != nil && turn.state == codexGoalTurnPending {
			turn.state = codexGoalTurnRejected
			turn.notifications = nil
			pending = append(pending, *turn)
		}
	}
	// Degraded is the permanent ambiguity tombstone. The detailed caches may
	// now be released without allowing a later fingerprint to be rebound.
	appSession.goalGenerationBindings = nil
	appSession.goalGenerationOrder = nil
	appSession.goalTurnEvidence = nil
	return pending
}

func (a *CodexAppServerAdapter) quiesceDegradedGoalTurns(pending []codexPendingGoalTurn, reason string) {
	for _, turn := range pending {
		a.quiesceUnprovenGoalTurn(turn.session, turn.providerTurnID, reason)
	}
}

func (a *CodexAppServerAdapter) sessionClientDone(agentSessionID string) <-chan struct{} {
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil || appSession.client == nil {
		closed := make(chan struct{})
		close(closed)
		return closed
	}
	return appSession.client.Done()
}

// bufferPendingGoalTurnNotification prevents output from an unproven provider
// turn from being projected onto a guessed local Turn. Once provenance is
// established, the buffered notifications are replayed through the normal
// reducer; otherwise they are discarded when that exact provider turn is
// quiesced.
func (a *CodexAppServerAdapter) bufferPendingGoalTurnNotification(agentSessionID, providerTurnID string, message acpMessage) bool {
	providerTurnID = strings.TrimSpace(providerTurnID)
	if a == nil || providerTurnID == "" {
		return false
	}
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		a.mu.Unlock()
		return false
	}
	if appSession.provenanceDegraded && strings.TrimSpace(appSession.activeTurnID) != providerTurnID {
		a.mu.Unlock()
		return true
	}
	pending := appSession.pendingGoalTurns[providerTurnID]
	if pending == nil {
		a.mu.Unlock()
		return false
	}
	if pending.state == codexGoalTurnRejected || pending.state == codexGoalTurnAborting {
		a.mu.Unlock()
		return true
	}
	if len(pending.notifications) >= maxPendingGoalTurnNotifications {
		if pending.state == codexGoalTurnAdopting {
			pending.state = codexGoalTurnAborting
			pending.notifications = nil
			appSession.provenanceDegraded = true
			appSession.goalGenerationBindings = nil
			appSession.goalGenerationOrder = nil
			appSession.goalTurnEvidence = nil
			session := pending.session
			activeTurn := appSession.activeTurn
			a.mu.Unlock()
			a.abortAdoptingGoalTurn(session, providerTurnID, activeTurn, "goal adoption notification capacity exceeded")
			return true
		}
		allPending := a.degradeGoalProvenanceLocked(appSession)
		a.mu.Unlock()
		a.quiesceDegradedGoalTurns(allPending, "goal provenance notification capacity exceeded")
		return true
	}
	pending.notifications = append(pending.notifications, message)
	a.mu.Unlock()
	return true
}

func (a *CodexAppServerAdapter) abortAdoptingGoalTurn(session Session, providerTurnID string, activeTurn *codexAppServerActiveTurn, reason string) {
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil || activeTurn == nil {
		return
	}
	client, threadID := appSession.client, appSession.threadID
	current := a.goalOperationIdentity(session.AgentSessionID)
	fenceMode := "current_durable"
	if current.valid() {
		fenceMode = "operation"
	}
	requestID := goalReconcileRequestID(providerTurnID)
	go func() {
		prepareErr := a.reportGoalReconcileRequired(session, requestID, providerTurnID, reason, fenceMode, current, "quiesce_pending", nil)
		if prepareErr != nil {
			slog.Warn("agent session app-server goal reconcile prepare was not acknowledged", "agent_session_id", session.AgentSessionID, "request_id", requestID, "error", prepareErr.Error())
			a.settleActiveTurn(session.AgentSessionID, providerTurnID, func(*codexAppServerActiveTurn) codexAppServerTurnTerminal {
				return codexAppServerTurnTerminal{err: fmt.Errorf("goal reconcile durable prepare failed: %w", prepareErr), phase: codexAppServerTurnPhaseFailed}
			})
			if closeErr := client.Close(); closeErr != nil {
				slog.Error("agent session app-server close after goal reconcile prepare failure failed", "agent_session_id", session.AgentSessionID, "request_id", requestID, "error", closeErr.Error())
			}
			return
		}
		quiesceErr := exactQuiesceGoalTurn(client, threadID, providerTurnID)
		if quiesceErr == nil {
			a.settleActiveTurn(session.AgentSessionID, providerTurnID, func(*codexAppServerActiveTurn) codexAppServerTurnTerminal {
				return codexAppServerTurnTerminal{err: context.Canceled, phase: codexAppServerTurnPhaseCanceled}
			})
		} else {
			a.settleActiveTurn(session.AgentSessionID, providerTurnID, func(*codexAppServerActiveTurn) codexAppServerTurnTerminal {
				return codexAppServerTurnTerminal{err: fmt.Errorf("goal adoption abort quiesce failed: %w", quiesceErr), phase: codexAppServerTurnPhaseFailed}
			})
			_ = client.Close()
		}
		if finalizeErr := a.reportGoalReconcileRequired(session, requestID, providerTurnID, reason, fenceMode, current, "finalized", quiesceErr); finalizeErr != nil {
			slog.Warn("agent session app-server goal reconcile finalize was not acknowledged",
				"agent_session_id", session.AgentSessionID, "request_id", requestID, "error", finalizeErr.Error())
		}
	}()
}

func exactQuiesceGoalTurn(client *codexAppServerClient, threadID, providerTurnID string) error {
	var quiesceErr error
	for attempt := 0; attempt < 3; attempt++ {
		quiesceErr = codexSendTurnInterruptOnce(client, threadID, strings.TrimSpace(providerTurnID))
		if quiesceErr == nil {
			return nil
		}
		if attempt < 2 {
			time.Sleep(time.Duration(attempt+1) * 50 * time.Millisecond)
		}
	}
	return quiesceErr
}

func (a *CodexAppServerAdapter) tryResolvePendingGoalTurn(agentSessionID, providerTurnID string) bool {
	if a == nil {
		return false
	}
	agentSessionID, providerTurnID = strings.TrimSpace(agentSessionID), strings.TrimSpace(providerTurnID)
	a.mu.Lock()
	appSession := a.sessions[agentSessionID]
	if appSession == nil {
		a.mu.Unlock()
		return false
	}
	pending := appSession.pendingGoalTurns[providerTurnID]
	if pending == nil {
		a.mu.Unlock()
		return false
	}
	evidence := appSession.goalTurnEvidence[providerTurnID]
	if evidence != nil {
		a.resolveGoalTurnEvidenceLocked(appSession, evidence)
	}
	identity := goalOperationIdentity{}
	provenanceMode := ""
	switch {
	case evidence != nil && evidence.bound:
		identity = evidence.identity
		provenanceMode = "turn_scoped_goal_update"
	case evidence != nil && evidence.ambiguous:
		// Exact provider evidence always wins over compatibility inference.
	case evidence != nil:
		a.mu.Unlock()
		return false
	default:
		claim := appSession.goalContinuationClaim
		current := goalOperationIdentity{
			operationID: appSession.goalOperationID,
			revision:    appSession.goalRevision,
			repairEpoch: appSession.goalRepairEpoch,
		}
		if claim == nil || !claim.ready || claim.identity != current || !claim.identity.valid() ||
			strings.TrimSpace(asString(appSession.goal["status"])) != "active" {
			a.mu.Unlock()
			return false
		}
		if len(appSession.pendingGoalTurns) != 1 {
			// More than one unowned provider turn cannot be causally ordered
			// against a single-use claim. Leave all of them to fail closed.
			appSession.goalContinuationClaim = nil
			a.mu.Unlock()
			return false
		}
		identity = claim.identity
		provenanceMode = "ordered_goal_continuation_claim"
		appSession.goalContinuationClaim = nil
	}
	// A newer set/clear changes future Goal scheduling, not work the provider
	// already accepted. Provenance is immutable, so a superseded but fully
	// proven Turn is adopted with its original identity and allowed to settle.
	shouldAdopt := identity.valid() && appSession.activeTurn == nil
	pending.provenanceMode = provenanceMode
	session := pending.session
	a.mu.Unlock()

	if shouldAdopt && a.goalBeforeAdoptHook != nil {
		a.goalBeforeAdoptHook()
	}
	if shouldAdopt && a.adoptServerInitiatedTurn(session, providerTurnID, identity) {
		return true
	}
	a.mu.Lock()
	appSession = a.sessions[agentSessionID]
	if appSession != nil && appSession.pendingGoalTurns[providerTurnID] == pending && pending.state == codexGoalTurnPending {
		delete(appSession.pendingGoalTurns, providerTurnID)
		delete(appSession.goalTurnEvidence, providerTurnID)
		a.pruneGoalProvenanceLocked(appSession)
		a.mu.Unlock()
		a.quiesceUnprovenGoalTurn(session, providerTurnID, "goal provenance ambiguous or could not be safely adopted")
		return true
	}
	a.mu.Unlock()
	return true
}

func (a *CodexAppServerAdapter) expirePendingGoalTurn(agentSessionID, providerTurnID string) {
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		a.mu.Unlock()
		return
	}
	pending := appSession.pendingGoalTurns[strings.TrimSpace(providerTurnID)]
	if pending == nil || pending.state != codexGoalTurnPending {
		a.mu.Unlock()
		return
	}
	evidence := appSession.goalTurnEvidence[strings.TrimSpace(providerTurnID)]
	if evidence != nil && evidence.lookupInFlight > 0 {
		grace := a.goalProvenanceGraceWindow
		if grace <= 0 {
			grace = defaultCodexAppServerGoalProvenanceGraceWindow
		}
		a.mu.Unlock()
		a.schedulePendingGoalTurnExpiry(agentSessionID, providerTurnID, grace)
		return
	}
	current := goalOperationIdentity{
		operationID: appSession.goalOperationID,
		revision:    appSession.goalRevision,
		repairEpoch: appSession.goalRepairEpoch,
	}
	if claim := appSession.goalContinuationClaim; claim != nil && !claim.ready && claim.identity == current {
		grace := a.goalProvenanceGraceWindow
		if grace <= 0 {
			grace = defaultCodexAppServerGoalProvenanceGraceWindow
		}
		a.mu.Unlock()
		a.schedulePendingGoalTurnExpiry(agentSessionID, providerTurnID, grace)
		return
	}
	delete(appSession.pendingGoalTurns, strings.TrimSpace(providerTurnID))
	delete(appSession.goalTurnEvidence, strings.TrimSpace(providerTurnID))
	a.pruneGoalProvenanceLocked(appSession)
	a.mu.Unlock()
	a.quiesceUnprovenGoalTurn(pending.session, providerTurnID, "goal provenance unavailable")
}

func (a *CodexAppServerAdapter) quiesceUnprovenGoalTurn(session Session, providerTurnID, reason string) {
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		return
	}
	client, threadID := appSession.client, appSession.threadID
	current := a.goalOperationIdentity(session.AgentSessionID)
	fenceMode := "current_durable"
	if current.valid() {
		fenceMode = "operation"
	}
	slog.Warn("agent session app-server quiescing unproven goal turn",
		"event", "agent_session.app_server.goal.turn_provenance_unproven",
		"agent_session_id", session.AgentSessionID,
		"provider_turn_id", providerTurnID,
		"reason", reason,
	)
	requestID := goalReconcileRequestID(providerTurnID)
	go func() {
		prepareErr := a.reportGoalReconcileRequired(session, requestID, providerTurnID, reason, fenceMode, current, "quiesce_pending", nil)
		if prepareErr != nil {
			slog.Warn("agent session app-server goal reconcile prepare was not acknowledged", "agent_session_id", session.AgentSessionID, "request_id", requestID, "error", prepareErr.Error())
			if closeErr := client.Close(); closeErr != nil {
				slog.Error("agent session app-server close after goal reconcile prepare failure failed", "agent_session_id", session.AgentSessionID, "request_id", requestID, "error", closeErr.Error())
			}
			return
		}
		// This path intentionally does not use sendThreadInterrupt: its stale-id
		// recovery targets the provider's *current* turn, while provenance
		// quiesce must affect this exact untrusted provider turn and nothing else.
		quiesceErr := exactQuiesceGoalTurn(client, threadID, providerTurnID)
		if quiesceErr != nil {
			slog.Warn("agent session app-server exact goal turn quiesce failed",
				"event", "agent_session.app_server.goal.turn_quiesce_failed",
				"agent_session_id", session.AgentSessionID,
				"provider_turn_id", providerTurnID,
				"error", quiesceErr.Error(),
			)
			_ = client.Close()
		}
		// The durable Host goal mutation lane is notified only after exact quiesce has
		// completed. Failed quiesce is explicit evidence: the service attaches
		// repair work and must not mark the observation converged.
		if finalizeErr := a.reportGoalReconcileRequired(session, requestID, providerTurnID, reason, fenceMode, current, "finalized", quiesceErr); finalizeErr != nil {
			slog.Warn("agent session app-server goal reconcile finalize was not acknowledged",
				"agent_session_id", session.AgentSessionID, "request_id", requestID, "error", finalizeErr.Error())
		}
	}()
}

func goalReconcileRequestID(providerTurnID string) string {
	return "goal-reconcile-required:" + strings.TrimSpace(providerTurnID) + ":" + newID()
}

func (a *CodexAppServerAdapter) reportGoalReconcileRequired(session Session, reconcileRequestID, providerTurnID, reason, fenceMode string, current goalOperationIdentity, phase string, quiesceErr error) error {
	eventContext, ok := activityEventContext(session, reconcileRequestID, "")
	if !ok {
		return fmt.Errorf("invalid goal reconcile activity context")
	}
	quiesceError := ""
	if quiesceErr != nil {
		quiesceError = quiesceErr.Error()
	}
	quiesceSucceeded := phase == "finalized" && quiesceErr == nil
	request := GoalReconcileDurableRequest{
		RequestID: reconcileRequestID, Phase: phase, ProviderTurnID: strings.TrimSpace(providerTurnID),
		Reason: reason, FenceMode: fenceMode, ExpectedOperationID: current.operationID,
		ExpectedRevision: current.revision, ExpectedRepairEpoch: current.repairEpoch,
		QuiesceSucceeded: quiesceSucceeded, QuiesceError: quiesceError,
	}
	a.mu.Lock()
	sink := a.goalReconcileSink
	timeout := a.goalReconcileAckTimeout
	a.mu.Unlock()
	if sink != nil {
		if timeout <= 0 {
			timeout = goalReconcileDurableAckTimeout
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		return sink(ctx, session, request)
	}
	// Standalone adapter users and reducer unit tests have no durable reporter.
	// Preserve the internal event surface there; production Controllers always
	// install GoalReconcileDurableSink during adapter configuration.
	a.emitSessionEvents(session.AgentSessionID, []activityshared.Event{
		activityshared.NewGoalReconcileRequired(eventContext, map[string]any{
			"requestId":                  reconcileRequestID,
			"phase":                      phase,
			"providerTurnId":             strings.TrimSpace(providerTurnID),
			"reason":                     reason,
			"fenceMode":                  fenceMode,
			"expectedGoalOperationId":    current.operationID,
			"expectedGoalRevision":       current.revision,
			"expectedGoalRepairEpoch":    current.repairEpoch,
			"providerGenerationEvidence": "thread_goal_updated",
			"quiesceSucceeded":           quiesceSucceeded,
			"quiesceError":               quiesceError,
		}),
	})
	return nil
}
