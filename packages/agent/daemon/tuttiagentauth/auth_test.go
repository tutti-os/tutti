package tuttiagentauth

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestReconcileIsIdempotentWhenCredentialMaterialReady(t *testing.T) {
	authorizer := &fakeAuthorizer{}
	store := &fakeStore{state: CredentialState{MaterialReady: true}}
	runner := &fakeRunner{}
	result, err := (&Reconciler{}).Reconcile(context.Background(), authorizer, store, runner, time.Now())
	if err != nil || result.Changed || authorizer.issueCalls != 0 || runner.calls != 0 {
		t.Fatalf("Reconcile() = %#v, %v; authorizer=%#v runner=%#v", result, err, authorizer, runner)
	}
}

func TestReconcileCompensatesFailedLoginWithoutLeakingTokens(t *testing.T) {
	now := time.Now().UTC()
	authorizer := &fakeAuthorizer{bundle: validBundle(now)}
	store := &fakeStore{}
	runner := &fakeRunner{err: errors.New("runner output contained lat_secret lrt_secret")}
	_, err := (&Reconciler{}).Reconcile(context.Background(), authorizer, store, runner, now)
	if err == nil {
		t.Fatal("Reconcile() error = nil")
	}
	if strings.Contains(err.Error(), "lat_secret") || strings.Contains(err.Error(), "lrt_secret") {
		t.Fatalf("Reconcile() leaked credential in error: %v", err)
	}
	if store.removeCalls != 1 || authorizer.revokeCalls != 1 || authorizer.lastReason != "login_failed" {
		t.Fatalf("compensation calls: store=%#v authorizer=%#v", store, authorizer)
	}
}

func TestReconcileVerifiesCredentialMaterialAfterLogin(t *testing.T) {
	now := time.Now().UTC()
	store := &fakeStore{}
	runner := &fakeRunner{afterLogin: store.setReady}
	result, err := (&Reconciler{}).Reconcile(context.Background(), &fakeAuthorizer{bundle: validBundle(now)}, store, runner, now)
	if err != nil || !result.Changed {
		t.Fatalf("Reconcile() = %#v, %v", result, err)
	}
}

func TestRemoveLocalDeletesBeforeReturningRevokeTarget(t *testing.T) {
	target := RevokeTarget{RefreshToken: "lrt_secret"}
	store := &fakeStore{state: CredentialState{MaterialReady: true, RevokeTarget: target}}
	got, err := (&Reconciler{}).RemoveLocal(context.Background(), store)
	if err != nil || got != target || store.removeCalls != 1 {
		t.Fatalf("RemoveLocal() = %#v, %v; store=%#v", got, err, store)
	}
}

func TestReconcilerSerializesConcurrentCredentialMutation(t *testing.T) {
	now := time.Now().UTC()
	reconciler := &Reconciler{}
	authorizer := &fakeAuthorizer{bundle: validBundle(now)}
	store := &fakeStore{}
	runner := &fakeRunner{afterLogin: store.setReady}
	start := make(chan struct{})
	errorsByCall := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			_, err := reconciler.Reconcile(context.Background(), authorizer, store, runner, now)
			errorsByCall <- err
		}()
	}
	close(start)
	for range 2 {
		if err := <-errorsByCall; err != nil {
			t.Fatal(err)
		}
	}
	if authorizer.issueCount() != 1 || runner.callCount() != 1 {
		t.Fatalf("concurrent reconcile issued %d token(s) and ran %d login(s)", authorizer.issueCount(), runner.callCount())
	}
}

func TestReconcileCompensationSurvivesCallerCancellation(t *testing.T) {
	now := time.Now().UTC()
	ctx, cancel := context.WithCancel(context.Background())
	authorizer := &fakeAuthorizer{bundle: validBundle(now)}
	store := &fakeStore{}
	runner := &fakeRunner{
		err:        errors.New("login failed"),
		afterLogin: cancel,
	}
	_, err := (&Reconciler{}).Reconcile(ctx, authorizer, store, runner, now)
	if err == nil {
		t.Fatal("Reconcile() error = nil")
	}
	if store.removeContextError() != nil || authorizer.revokeContextError() != nil {
		t.Fatalf("compensation inherited cancellation: remove=%v revoke=%v", store.removeContextError(), authorizer.revokeContextError())
	}
}

func validBundle(now time.Time) TokenBundle {
	return TokenBundle{
		AppID: "233749", AccountBaseURL: "https://account.example", AccessToken: "lat_secret",
		AccessTokenExpiresAt: now.Add(time.Hour).Unix(), RefreshToken: "lrt_secret",
		RefreshTokenExpiresAt: now.Add(24 * time.Hour).Unix(), TokenType: "Bearer",
		Scopes: []string{ScopeModels, ScopeChat},
	}
}

type fakeAuthorizer struct {
	mu           sync.Mutex
	bundle       TokenBundle
	issueErr     error
	issueCalls   int
	revokeCalls  int
	lastReason   string
	revokeCtxErr error
}

func (f *fakeAuthorizer) Issue(context.Context) (TokenBundle, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.issueCalls++
	return f.bundle, f.issueErr
}

func (f *fakeAuthorizer) Revoke(ctx context.Context, _ RevokeTarget, reason string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.revokeCalls++
	f.lastReason = reason
	f.revokeCtxErr = ctx.Err()
	return nil
}

func (f *fakeAuthorizer) issueCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.issueCalls
}

func (f *fakeAuthorizer) revokeContextError() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.revokeCtxErr
}

type fakeStore struct {
	mu           sync.Mutex
	state        CredentialState
	inspectErr   error
	removeErr    error
	removeCalls  int
	removeCtxErr error
}

func (f *fakeStore) Inspect(context.Context) (CredentialState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state, f.inspectErr
}
func (f *fakeStore) Remove(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removeCalls++
	f.removeCtxErr = ctx.Err()
	return f.removeErr
}

func (f *fakeStore) setReady() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.state.MaterialReady = true
}

func (f *fakeStore) removeContextError() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.removeCtxErr
}

type fakeRunner struct {
	mu         sync.Mutex
	err        error
	calls      int
	afterLogin func()
}

func (f *fakeRunner) Login(context.Context, TokenBundle) error {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	if f.afterLogin != nil {
		f.afterLogin()
	}
	return f.err
}

func (f *fakeRunner) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}
