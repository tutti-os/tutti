package agenthost

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// recoverSessionForkTurnBinding is an exceptional repair path for historical
// Turns. Normal execution durably binds the provider Turn before returning
// acceptance, so Fork never depends on this lookup in the healthy path.
func (h *Host) recoverSessionForkTurnBinding(
	ctx context.Context,
	workspaceID, sessionID, turnID string,
) error {
	recoveryStore, storeOK := h.sessionForks.(SessionForkTurnBindingRecoveryStore)
	recoveryRuntime, runtimeOK :=
		h.sessionForkRuntime.(SessionForkTurnBindingRecoveryRuntime)
	if !storeOK || !runtimeOK {
		return storesqlite.ErrSessionForkTurnState
	}
	source, found, err := h.sessionForks.GetSessionForkSource(
		ctx,
		workspaceID,
		sessionID,
	)
	if err != nil {
		return err
	}
	if !found {
		return ErrSessionNotFound
	}
	turn, found, err := h.store.GetTurn(ctx, workspaceID, sessionID, turnID)
	if err != nil {
		return err
	}
	if !found || turn.Phase != storesqlite.TurnPhaseSettled {
		return storesqlite.ErrSessionForkTurnState
	}

	recoveryInput := RuntimeProviderTurnBindingRecoveryInput{
		CanonicalTurnID: turnID,
	}
	claim, claimFound, err := recoveryStore.FindSubmitClaimByCanonicalTurn(
		ctx,
		workspaceID,
		sessionID,
		turnID,
	)
	if err != nil {
		return err
	}
	if claimFound && strings.TrimSpace(claim.ClientSubmitID) != "" {
		recoveryInput.RecoveryToken = strings.TrimSpace(claim.ClientSubmitID)
	} else {
		key, digest, proofErr := h.legacyTurnTextProof(
			ctx,
			workspaceID,
			sessionID,
			turnID,
		)
		if proofErr != nil {
			return proofErr
		}
		recoveryInput.LegacyTextHMACKey = key
		recoveryInput.LegacyTextHMACDigest = digest
	}

	runtimeSource, err := h.sessionForkRuntimeSource(ctx, source)
	if err != nil {
		return err
	}
	recoveryInput.Source = runtimeSource
	recovered, err := recoveryRuntime.RecoverProviderTurnBinding(ctx, recoveryInput)
	if err != nil {
		return fmt.Errorf("recover provider turn binding: %w", err)
	}
	if strings.TrimSpace(recovered.ProviderSessionID) !=
		strings.TrimSpace(runtimeSource.ProviderSessionID) ||
		strings.TrimSpace(recovered.ProviderTurnID) == "" {
		return errors.New("recovered provider turn identity does not match source session")
	}
	_, err = recoveryStore.RecoverProviderTurnBinding(
		ctx,
		storesqlite.ProviderTurnBindingRecovery{
			WorkspaceID:               workspaceID,
			AgentSessionID:            sessionID,
			TurnID:                    turnID,
			ExpectedProviderSessionID: strings.TrimSpace(recovered.ProviderSessionID),
			ProviderTurnID:            strings.TrimSpace(recovered.ProviderTurnID),
			ProviderTurnBindingJSON: append(
				[]byte(nil),
				recovered.ProviderTurnBindingJSON...,
			),
			OccurredAtUnixMS: h.now().UnixMilli(),
		},
	)
	return err
}

func (h *Host) legacyTurnTextProof(
	ctx context.Context,
	workspaceID, sessionID, turnID string,
) (string, string, error) {
	if h.turnSubmissions == nil {
		return "", "", storesqlite.ErrSessionForkTurnState
	}
	submission, found, err := h.turnSubmissions.GetTurnSubmission(
		ctx,
		workspaceID,
		sessionID,
		turnID,
	)
	if err != nil {
		return "", "", err
	}
	if !found || strings.TrimSpace(submission.ClientSubmitID) != "" ||
		nonEmptyJSON(submission.CapabilityRefsJSON) ||
		nonEmptyJSON(submission.TuttiModeSnapshotJSON) {
		return "", "", storesqlite.ErrSessionForkTurnState
	}
	var content []PromptContentBlock
	if json.Unmarshal([]byte(submission.ContentJSON), &content) != nil ||
		len(content) != 1 ||
		strings.TrimSpace(content[0].Type) != "text" ||
		content[0].Text == "" ||
		content[0].MimeType != "" ||
		content[0].Data != "" ||
		content[0].URL != "" ||
		content[0].AttachmentID != "" ||
		content[0].Name != "" ||
		content[0].Path != "" ||
		submission.DisplayPrompt != content[0].Text {
		return "", "", storesqlite.ErrSessionForkTurnState
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return "", "", err
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(content[0].Text))
	return base64.RawURLEncoding.EncodeToString(key),
		base64.RawURLEncoding.EncodeToString(mac.Sum(nil)),
		nil
}

func nonEmptyJSON(value string) bool {
	switch strings.TrimSpace(value) {
	case "", "null", "[]", "{}":
		return false
	default:
		return true
	}
}
