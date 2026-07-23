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

type linkResult struct {
	link *authenticated.Link
	err  error
}
