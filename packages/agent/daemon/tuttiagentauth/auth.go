// Package tuttiagentauth owns the host-neutral Tutti Agent credential
// reconciliation order. Account sessions, credential paths, process execution,
// and VM transport remain host adapters.
package tuttiagentauth

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	ScopeModels = "llm:models"
	ScopeChat   = "llm:chat"
)

type TokenBundle struct {
	AppID                 string   `json:"app_id"`
	AccountBaseURL        string   `json:"account_base_url"`
	AccessToken           string   `json:"access_token"`
	AccessTokenExpiresAt  int64    `json:"access_token_expires_at"`
	RefreshToken          string   `json:"refresh_token"`
	RefreshTokenExpiresAt int64    `json:"refresh_token_expires_at"`
	TokenType             string   `json:"token_type"`
	Scopes                []string `json:"scopes"`
}

func (b TokenBundle) Validate(now time.Time) error {
	if strings.TrimSpace(b.AppID) == "" || strings.TrimSpace(b.AccountBaseURL) == "" {
		return fmt.Errorf("token bundle identity is incomplete")
	}
	if strings.TrimSpace(b.AccessToken) == "" || strings.TrimSpace(b.RefreshToken) == "" {
		return fmt.Errorf("token bundle credentials are incomplete")
	}
	if b.AccessTokenExpiresAt <= now.Unix() || b.RefreshTokenExpiresAt <= now.Unix() {
		return fmt.Errorf("token bundle is already expired")
	}
	if !slices.Contains(b.Scopes, ScopeModels) || !slices.Contains(b.Scopes, ScopeChat) {
		return fmt.Errorf("token bundle is missing required scopes")
	}
	return nil
}

type RevokeTarget struct {
	AccountBaseURL string
	RefreshToken   string
}

func (t RevokeTarget) Valid() bool {
	return strings.TrimSpace(t.RefreshToken) != ""
}

type CredentialState struct {
	// MaterialReady only means the canonical credential material exists and is
	// locally usable for a provider probe. It does not prove that the provider
	// accepted the credential, and must not be projected as product readiness.
	MaterialReady bool
	RevokeTarget  RevokeTarget
}

// Reconciler serializes all mutations of one canonical credential authority.
// A host must use the same instance for reconcile and logout, and must call
// RemoveLocal during an account switch before reconciling the next account.
type Reconciler struct {
	mu sync.Mutex
}

type SessionAuthorizer interface {
	Issue(context.Context) (TokenBundle, error)
	Revoke(context.Context, RevokeTarget, string) error
}

type CredentialStore interface {
	Inspect(context.Context) (CredentialState, error)
	Remove(context.Context) error
}

type LoginRunner interface {
	Login(context.Context, TokenBundle) error
}

type ReconcileResult struct {
	Changed bool
}

type StageError struct {
	Stage string
	Err   error
}

func (e StageError) Error() string {
	return "tutti-agent auth " + strings.TrimSpace(e.Stage) + " failed"
}

func (e StageError) Unwrap() error { return e.Err }

func (r *Reconciler) Reconcile(ctx context.Context, authorizer SessionAuthorizer, store CredentialStore, runner LoginRunner, now time.Time) (ReconcileResult, error) {
	if r == nil {
		return ReconcileResult{}, fmt.Errorf("tutti-agent auth reconciler is required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if ctx == nil {
		ctx = context.Background()
	}
	if authorizer == nil || store == nil || runner == nil {
		return ReconcileResult{}, fmt.Errorf("tutti-agent auth adapters are required")
	}
	state, err := store.Inspect(ctx)
	if err != nil {
		return ReconcileResult{}, StageError{Stage: "inspect", Err: err}
	}
	if state.MaterialReady {
		return ReconcileResult{}, nil
	}
	bundle, err := authorizer.Issue(ctx)
	if err != nil {
		return ReconcileResult{}, StageError{Stage: "issue", Err: err}
	}
	if err := bundle.Validate(now); err != nil {
		return ReconcileResult{}, compensate(ctx, authorizer, store, bundle.RevokeTarget(), "invalid_bundle", StageError{Stage: "validate", Err: err})
	}
	if err := runner.Login(ctx, bundle); err != nil {
		return ReconcileResult{}, compensate(ctx, authorizer, store, bundle.RevokeTarget(), "login_failed", StageError{Stage: "login", Err: err})
	}
	state, err = store.Inspect(ctx)
	if err != nil || !state.MaterialReady {
		if err == nil {
			err = errors.New("credential material did not become usable")
		}
		return ReconcileResult{}, compensate(ctx, authorizer, store, bundle.RevokeTarget(), "not_ready", StageError{Stage: "verify", Err: err})
	}
	return ReconcileResult{Changed: true}, nil
}

func (b TokenBundle) RevokeTarget() RevokeTarget {
	return RevokeTarget{AccountBaseURL: b.AccountBaseURL, RefreshToken: b.RefreshToken}
}

func (r *Reconciler) RemoveLocal(ctx context.Context, store CredentialStore) (RevokeTarget, error) {
	if r == nil {
		return RevokeTarget{}, fmt.Errorf("tutti-agent auth reconciler is required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if ctx == nil {
		ctx = context.Background()
	}
	if store == nil {
		return RevokeTarget{}, fmt.Errorf("tutti-agent credential store is required")
	}
	state, inspectErr := store.Inspect(ctx)
	removeErr := store.Remove(ctx)
	if removeErr != nil {
		return RevokeTarget{}, StageError{Stage: "remove", Err: removeErr}
	}
	if inspectErr != nil {
		return RevokeTarget{}, StageError{Stage: "inspect", Err: inspectErr}
	}
	return state.RevokeTarget, nil
}

func compensate(ctx context.Context, authorizer SessionAuthorizer, store CredentialStore, target RevokeTarget, reason string, primary error) error {
	compensationCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	removeErr := store.Remove(compensationCtx)
	var revokeErr error
	if target.Valid() {
		revokeErr = authorizer.Revoke(compensationCtx, target, reason)
	}
	if removeErr != nil {
		removeErr = StageError{Stage: "compensating_remove", Err: removeErr}
	}
	if revokeErr != nil {
		revokeErr = StageError{Stage: "compensating_revoke", Err: revokeErr}
	}
	return errors.Join(primary, removeErr, revokeErr)
}
