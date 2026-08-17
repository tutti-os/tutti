package mobileremote

import (
	"context"
	"errors"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/tutti-os/tutti/packages/device-link/authenticated"
	"github.com/tutti-os/tutti/packages/device-link/candidateexchange"
	mobileremotebiz "github.com/tutti-os/tutti/services/tuttid/biz/mobileremote"
)

type immediateRefreshControlPlane struct {
	ControlPlane
	called chan struct{}
	once   sync.Once
}

type publishOnlyControlPlane struct {
	ControlPlane
	called chan DeviceLinkParticipantInput
}

func (c *publishOnlyControlPlane) UpdateDeviceLinkParticipant(
	_ context.Context,
	_ string,
	_ string,
	attemptID string,
	_ string,
	input DeviceLinkParticipantInput,
) (DeviceLinkAttempt, error) {
	select {
	case c.called <- input:
	default:
	}
	return DeviceLinkAttempt{
		AttemptID:        attemptID,
		OwnerFingerprint: input.Fingerprint,
		OwnerICE:         &input.ICE,
		State:            "ready",
	}, nil
}

func (*publishOnlyControlPlane) ListDeviceLinkAttempts(
	ctx context.Context,
	_ string,
	_ string,
	_ string,
	_ []byte,
) ([]DeviceLinkAttempt, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func TestRemoteCandidateExchangePublishesGatheredOwnerCandidates(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	exchange, initial, err := candidateexchange.Start(participant, candidateexchange.Config{LocalDebounce: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	controlPlane := &publishOnlyControlPlane{called: make(chan DeviceLinkParticipantInput, 2)}
	service := &Service{ControlPlane: controlPlane}
	ctx, cancel := context.WithCancel(context.Background())
	stop := service.runRemoteCandidateExchange(
		ctx,
		"cookie",
		mobileremotebiz.DeviceIdentity{DeviceID: "owner-device", PrivateKey: make([]byte, 64)},
		"pairing-1",
		"attempt-1",
		"caller-fingerprint",
		DeviceLinkICEParams{Ufrag: "caller-ufrag", Pwd: "caller-pwd"},
		0,
		exchange,
		cancel,
	)
	defer stop()

	select {
	case publication := <-controlPlane.called:
		if publication.Fingerprint != initial.Fingerprint ||
			publication.ICE.Ufrag != initial.Ufrag || publication.ICE.Pwd != initial.Pwd {
			t.Fatalf("published owner identity changed: %+v", publication)
		}
		if len(publication.ICE.Candidates) == 0 {
			t.Fatal("owner candidate worker published an empty gathered snapshot")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("owner candidate worker did not publish a gathered snapshot")
	}
}

func (c *immediateRefreshControlPlane) ListDeviceLinkAttempts(
	context.Context,
	string,
	string,
	string,
	[]byte,
) ([]DeviceLinkAttempt, error) {
	c.once.Do(func() { close(c.called) })
	return nil, errRemoteCandidateIdentityChanged
}

func (*immediateRefreshControlPlane) UpdateDeviceLinkParticipant(
	context.Context,
	string,
	string,
	string,
	string,
	DeviceLinkParticipantInput,
) (DeviceLinkAttempt, error) {
	return DeviceLinkAttempt{}, context.Canceled
}

func TestRemoteCandidateExchangeRefreshesImmediately(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	exchange, _, err := candidateexchange.Start(participant, candidateexchange.Config{RemotePoll: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	controlPlane := &immediateRefreshControlPlane{called: make(chan struct{})}
	service := &Service{ControlPlane: controlPlane}
	service.remoteHost.attemptWake = NewAttemptWake()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop := service.runRemoteCandidateExchange(
		ctx,
		"cookie",
		mobileremotebiz.DeviceIdentity{DeviceID: "owner-device", PrivateKey: make([]byte, 64)},
		"pairing-1",
		"attempt-1",
		"caller-fingerprint",
		DeviceLinkICEParams{Ufrag: "caller-ufrag", Pwd: "caller-pwd"},
		0,
		exchange,
		cancel,
	)
	defer stop()

	select {
	case <-controlPlane.called:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("initial authoritative candidate refresh waited for the poll fallback")
	}
}

func TestCandidateExchangeRetryClassification(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{name: "request timeout", err: &ControlPlaneError{StatusCode: http.StatusRequestTimeout}, want: true},
		{name: "rate limited", err: &ControlPlaneError{StatusCode: http.StatusTooManyRequests}, want: true},
		{name: "server failure", err: &ControlPlaneError{StatusCode: http.StatusBadGateway}, want: true},
		{name: "invalid request", err: &ControlPlaneError{StatusCode: http.StatusBadRequest}},
		{name: "decode failure", err: errors.New("decode control-plane response")},
		{name: "request deadline", err: context.DeadlineExceeded, want: true},
		{name: "worker cancelled", err: context.Canceled},
		{name: "network timeout", err: &net.DNSError{IsTimeout: true}, want: true},
		{name: "identity changed", err: errRemoteCandidateIdentityChanged},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := isRetryableCandidateExchangeError(tt.err); got != tt.want {
				t.Fatalf("isRetryableCandidateExchangeError(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}

func TestValidateOwnerCandidatePublicationRequiresAuthoritativeSnapshot(t *testing.T) {
	t.Parallel()
	description := authenticated.Description{
		Fingerprint: "owner-fingerprint",
		Ufrag:       "owner-ufrag",
		Pwd:         "owner-pwd",
		Candidates:  []string{"candidate-1", "candidate-2"},
	}
	valid := DeviceLinkAttempt{
		AttemptID:        "attempt-1",
		State:            "ready",
		OwnerFingerprint: description.Fingerprint,
		OwnerICE: &DeviceLinkICEParams{
			Ufrag: description.Ufrag, Pwd: description.Pwd,
			Candidates: []string{"candidate-2", "candidate-1", "candidate-server"},
		},
	}
	if err := validateOwnerCandidatePublication(valid, "attempt-1", description); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name   string
		mutate func(*DeviceLinkAttempt)
	}{
		{name: "attempt changed", mutate: func(value *DeviceLinkAttempt) { value.AttemptID = "attempt-2" }},
		{name: "not ready", mutate: func(value *DeviceLinkAttempt) { value.State = "awaiting_owner" }},
		{name: "fingerprint changed", mutate: func(value *DeviceLinkAttempt) { value.OwnerFingerprint = "other" }},
		{name: "credentials changed", mutate: func(value *DeviceLinkAttempt) { value.OwnerICE.Ufrag = "other" }},
		{name: "candidate missing", mutate: func(value *DeviceLinkAttempt) { value.OwnerICE.Candidates = []string{"candidate-1"} }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			candidate := valid
			ownerICE := *valid.OwnerICE
			ownerICE.Candidates = append([]string(nil), valid.OwnerICE.Candidates...)
			candidate.OwnerICE = &ownerICE
			tt.mutate(&candidate)
			if err := validateOwnerCandidatePublication(candidate, "attempt-1", description); !errors.Is(err, errOwnerCandidateUpdateRejected) {
				t.Fatalf("validation error = %v, want publication rejection", err)
			}
		})
	}
}

func TestMatchingCallerCandidatesRequiresReadyAuthoritativeAttempt(t *testing.T) {
	t.Parallel()
	callerICE := DeviceLinkICEParams{
		Ufrag: "caller-ufrag", Pwd: "caller-pwd", Candidates: []string{"candidate-1"},
	}
	attempt := DeviceLinkAttempt{
		AttemptID:         "attempt-1",
		CallerFingerprint: "caller-fingerprint",
		CallerICE:         &callerICE,
		State:             "ready",
	}
	candidates, err := matchingCallerCandidates(
		[]DeviceLinkAttempt{attempt},
		"attempt-1",
		"caller-fingerprint",
		callerICE,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 || candidates[0] != "candidate-1" {
		t.Fatalf("candidates = %#v, want authoritative caller snapshot", candidates)
	}

	attempt.State = "awaiting_owner"
	if _, err := matchingCallerCandidates(
		[]DeviceLinkAttempt{attempt},
		"attempt-1",
		"caller-fingerprint",
		callerICE,
	); !errors.Is(err, errRemoteCandidateIdentityChanged) {
		t.Fatalf("validation error = %v, want remote identity rejection", err)
	}
}
