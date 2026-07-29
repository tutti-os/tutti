package authenticated_test

import (
	"context"
	"io"
	"testing"
	"time"

	authenticated "github.com/tutti-os/tutti/packages/device-link/authenticated"
)

func TestAuthenticatedParticipantsCarryBidirectionalStream(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	caller, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer caller.Close()
	owner, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()

	callerDescription, err := caller.LocalDescription(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ownerDescription, err := owner.LocalDescription(ctx)
	if err != nil {
		t.Fatal(err)
	}

	ownerResult := make(chan linkResult, 1)
	go func() {
		link, connectErr := owner.Connect(ctx, callerDescription, authenticated.RoleOwner)
		ownerResult <- linkResult{link: link, err: connectErr}
	}()
	callerLink, err := caller.Connect(ctx, ownerDescription, authenticated.RoleCaller)
	if err != nil {
		t.Fatal(err)
	}
	defer callerLink.Close()
	result := <-ownerResult
	if result.err != nil {
		t.Fatal(result.err)
	}
	defer result.link.Close()

	serveDone := make(chan error, 1)
	go func() {
		stream, acceptErr := result.link.AcceptStream(ctx)
		if acceptErr != nil {
			serveDone <- acceptErr
			return
		}
		defer stream.Close()
		_, copyErr := io.Copy(stream, stream)
		serveDone <- copyErr
	}()

	stream, err := callerLink.OpenStream(ctx)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("authenticated-device-link")
	if _, err := stream.Write(payload); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(stream, got); err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) {
		t.Fatalf("echo = %q, want %q", got, payload)
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-serveDone; err != nil && err != io.EOF {
		t.Fatal(err)
	}
}

func TestAuthenticatedParticipantRejectsInvalidPeerBeforeConnecting(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	_, err = participant.Connect(context.Background(), authenticated.Description{
		Fingerprint: "invalid", Ufrag: "ufrag", Pwd: "pwd", Candidates: []string{"candidate"},
	}, authenticated.RoleCaller)
	if err == nil {
		t.Fatal("Connect succeeded with invalid peer fingerprint")
	}
}

func TestAuthenticatedParticipantsAcceptCredentialsBeforeCandidateTrickle(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	caller, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer caller.Close()
	owner, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()

	callerInitial, err := caller.StartLocalDescription()
	if err != nil {
		t.Fatal(err)
	}
	ownerInitial, err := owner.StartLocalDescription()
	if err != nil {
		t.Fatal(err)
	}
	if caller.LocalCandidateChanges() == nil || owner.LocalGatheringComplete() == nil {
		t.Fatal("authenticated trickle signals are unavailable")
	}
	callerFull, err := caller.LocalDescription(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ownerFull, err := owner.LocalDescription(ctx)
	if err != nil {
		t.Fatal(err)
	}
	callerInitial.Candidates = nil
	ownerInitial.Candidates = nil

	callerResult := make(chan linkResult, 1)
	ownerResult := make(chan linkResult, 1)
	go func() {
		link, connectErr := caller.Connect(ctx, ownerInitial, authenticated.RoleCaller)
		callerResult <- linkResult{link: link, err: connectErr}
	}()
	go func() {
		link, connectErr := owner.Connect(ctx, callerInitial, authenticated.RoleOwner)
		ownerResult <- linkResult{link: link, err: connectErr}
	}()
	time.Sleep(50 * time.Millisecond)
	if added := caller.AddRemoteCandidates(ownerFull.Candidates); added == 0 {
		t.Fatal("caller accepted no trickled owner candidates")
	}
	if added := owner.AddRemoteCandidates(callerFull.Candidates); added == 0 {
		t.Fatal("owner accepted no trickled caller candidates")
	}

	callerConnected, ownerConnected := <-callerResult, <-ownerResult
	if callerConnected.err != nil {
		t.Fatalf("caller Connect after trickle: %v", callerConnected.err)
	}
	if ownerConnected.err != nil {
		t.Fatalf("owner Connect after trickle: %v", ownerConnected.err)
	}
	defer callerConnected.link.Close()
	defer ownerConnected.link.Close()
}

func TestAuthenticatedParticipantRejectsInvalidCompatibleProtocol(t *testing.T) {
	t.Parallel()
	_, err := authenticated.NewParticipant(authenticated.ParticipantConfig{
		IncludeLoopback:     true,
		CompatibleProtocols: []string{" "},
	})
	if err == nil {
		t.Fatal("NewParticipant accepted an empty compatible protocol")
	}
}

func TestAuthenticatedParticipantDoneRemainsObservableAfterClose(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	done := participant.Done()
	if done == nil {
		t.Fatal("Done returned a nil channel")
	}
	if err := participant.Close(); err != nil {
		t.Fatal(err)
	}
	if participant.Done() != done {
		t.Fatal("Done channel changed after Close")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Done did not close")
	}
}

type linkResult struct {
	link *authenticated.Link
	err  error
}
