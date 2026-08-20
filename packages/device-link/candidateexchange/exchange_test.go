package candidateexchange

import (
	"context"
	"errors"
	"io"
	"net"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/tutti-os/tutti/packages/device-link/authenticated"
)

func TestExchangeReportsParticipantCloseBeforeGatheringCompletion(t *testing.T) {
	t.Parallel()
	participant := newBlockedGatherParticipant(t)
	exchange, _, err := Start(participant, Config{LocalDebounce: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if err := participant.Close(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := exchange.NextLocal(ctx); !errors.Is(err, ErrParticipantClosed) {
		t.Fatalf("NextLocal error = %v, want ErrParticipantClosed", err)
	}
}

func TestExchangePublishLocalDoesNotSwallowParticipantClose(t *testing.T) {
	t.Parallel()
	participant := newBlockedGatherParticipant(t)
	exchange, _, err := Start(participant, Config{LocalDebounce: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if err := participant.Close(); err != nil {
		t.Fatal(err)
	}
	err = exchange.PublishLocal(context.Background(), func(context.Context, authenticated.Description) error {
		return nil
	}, nil)
	if !errors.Is(err, ErrParticipantClosed) {
		t.Fatalf("PublishLocal error = %v, want ErrParticipantClosed", err)
	}
}

func TestExchangeImmediateFalseRemoteWaitUsesPollFallback(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	poll := 40 * time.Millisecond
	exchange, _, err := Start(participant, Config{RemotePoll: poll})
	if err != nil {
		t.Fatal(err)
	}
	startedAt := time.Now()
	if err := exchange.waitForRemoteRefresh(context.Background(), func(context.Context) bool {
		return false
	}); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(startedAt); elapsed < poll/2 {
		t.Fatalf("immediate false wait returned after %v, want poll fallback near %v", elapsed, poll)
	}
}

func TestExchangeRemoteNotificationBypassesPollFallback(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	exchange, _, err := Start(participant, Config{RemotePoll: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	exchange.NotifyRemoteChange()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := exchange.WaitRemoteRefresh(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestExchangePublishesTrickledCandidatesAndCompletion(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	exchange, initial, err := Start(participant, Config{LocalDebounce: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if initial.Ufrag == "" || initial.Pwd == "" || initial.Fingerprint == "" {
		t.Fatalf("initial description is incomplete: %+v", initial)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var updates []LocalUpdate
	for {
		update, nextErr := exchange.NextLocal(ctx)
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			t.Fatal(nextErr)
		}
		updates = append(updates, update)
		if update.GatheringComplete {
			break
		}
	}
	if len(updates) == 0 || !updates[len(updates)-1].GatheringComplete {
		t.Fatalf("local updates = %+v, want final gathering completion", updates)
	}
	final := updates[len(updates)-1].Description
	if len(final.Candidates) == 0 {
		t.Fatal("final local description contains no loopback candidate")
	}
	if _, err := exchange.NextLocal(ctx); !errors.Is(err, io.EOF) {
		t.Fatalf("NextLocal after completion error = %v, want EOF", err)
	}
}

func TestExchangePublishLocalRetriesTheSameSnapshot(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	exchange, _, err := Start(participant, Config{
		LocalDebounce: time.Millisecond,
		PublishRetry:  time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wantRetry := errors.New("retry publish")
	var mu sync.Mutex
	var attempts [][]string
	err = exchange.PublishLocal(ctx, func(_ context.Context, description authenticated.Description) error {
		mu.Lock()
		defer mu.Unlock()
		attempts = append(attempts, append([]string(nil), description.Candidates...))
		if len(attempts) == 1 {
			return wantRetry
		}
		return nil
	}, func(err error) bool {
		return errors.Is(err, wantRetry)
	})
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(attempts) < 2 {
		t.Fatalf("publish attempts = %d, want a retry", len(attempts))
	}
	if len(attempts[0]) == 0 || len(attempts[0]) != len(attempts[1]) {
		t.Fatalf("retry snapshots = %#v, want the same non-empty candidate set", attempts[:2])
	}
	for i := range attempts[0] {
		if attempts[0][i] != attempts[1][i] {
			t.Fatalf("retry snapshot changed: %#v", attempts[:2])
		}
	}
}

func TestExchangeLocalPublicationRequiresAcknowledgement(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	exchange, _, err := Start(participant, Config{
		LocalDebounce: time.Millisecond,
		PublishRetry:  time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	publication, err := exchange.NextLocalPublication(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !publication.CandidateChanged || publication.ID == 0 {
		t.Fatalf("first publication = %+v, want candidate snapshot with ID", publication)
	}
	originalCandidates := append([]string(nil), publication.Description.Candidates...)
	publication.Description.Candidates[0] = "mutated-by-caller"
	retry, err := exchange.NextLocalPublication(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if retry.ID != publication.ID || !slices.Equal(retry.Description.Candidates, originalCandidates) {
		t.Fatalf("retry publication = %+v, want exact publication %+v", retry, publication)
	}
	retry.Description.Candidates[0] = "mutated-retry"
	secondRetry, err := exchange.NextLocalPublication(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(secondRetry.Description.Candidates, originalCandidates) {
		t.Fatalf("second retry candidates = %#v, want isolated snapshot %#v", secondRetry.Description.Candidates, originalCandidates)
	}
	if err := exchange.AcknowledgeLocalPublication(publication.ID); err != nil {
		t.Fatal(err)
	}
	if err := exchange.AcknowledgeLocalPublication(publication.ID); err == nil {
		t.Fatal("duplicate publication acknowledgement succeeded")
	}
}

func TestExchangeFeedRemoteUsesWakeAndPollFallback(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	exchange, _, err := Start(participant, Config{RemotePoll: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	wake := make(chan struct{}, 1)
	fetched := make(chan struct{}, 2)
	done := make(chan error, 1)
	go func() {
		done <- exchange.FeedRemote(ctx, func(waitCtx context.Context) bool {
			select {
			case <-wake:
				return true
			case <-waitCtx.Done():
				return false
			}
		}, func(context.Context) ([]string, error) {
			fetched <- struct{}{}
			return nil, nil
		}, func(error) bool { return true }, nil)
	}()
	wake <- struct{}{}
	for i := 0; i < 2; i++ {
		select {
		case <-fetched:
		case <-time.After(time.Second):
			t.Fatalf("remote fetch %d did not run", i+1)
		}
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("FeedRemote error = %v, want context cancellation", err)
		}
	case <-time.After(time.Second):
		t.Fatal("FeedRemote did not stop")
	}
}

func TestExchangeFeedRemoteReturnsTerminalFetchError(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	exchange, _, err := Start(participant, Config{RemotePoll: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	want := errors.New("invalid authoritative attempt")
	err = exchange.FeedRemote(
		context.Background(),
		func(context.Context) bool { return true },
		func(context.Context) ([]string, error) { return nil, want },
		func(error) bool { return false },
		nil,
	)
	if !errors.Is(err, want) {
		t.Fatalf("FeedRemote error = %v, want %v", err, want)
	}
}

func newBlockedGatherParticipant(t *testing.T) *authenticated.Participant {
	t.Helper()
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{
		STUNEndpoints: []string{
			"stun:127.0.0.1:" + strconv.Itoa(conn.LocalAddr().(*net.UDPAddr).Port),
		},
		STUNGatherTimeout:     5 * time.Second,
		ExcludeHostCandidates: true,
		IncludeLoopback:       true,
	})
	if err != nil {
		t.Fatal(err)
	}
	return participant
}
