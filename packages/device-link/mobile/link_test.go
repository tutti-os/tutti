package mobile

import (
	"io"
	"net"
	"testing"
)

func TestStreamReadPreservesFinalBytesReturnedWithEOF(t *testing.T) {
	t.Parallel()
	stream := &Stream{conn: &finalBytesConn{remaining: []byte("final response frame")}}
	buffer := make([]byte, 1024)

	count := stream.ReadInto(buffer)
	if count != len("final response frame") {
		t.Fatalf("read final bytes count = %d, want %d", count, len("final response frame"))
	}
	if string(buffer[:count]) != "final response frame" {
		t.Fatalf("read = %q, want final response frame", buffer[:count])
	}

	if count := stream.ReadInto(buffer); count != -1 {
		t.Fatalf("read after final bytes count = %d, want -1", count)
	}
}

func TestLoopbackLinksExchangeDescriptionsAndStreams(t *testing.T) {
	t.Parallel()
	caller, err := NewLoopbackLink()
	if err != nil {
		t.Fatal(err)
	}
	defer caller.Close()
	owner, err := NewLoopbackLink()
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()

	callerDescription, err := caller.LocalDescription(20_000)
	if err != nil {
		t.Fatal(err)
	}
	ownerDescription, err := owner.LocalDescription(20_000)
	if err != nil {
		t.Fatal(err)
	}
	ownerResult := make(chan error, 1)
	go func() {
		_, connectErr := owner.Connect(callerDescription, false, 20_000)
		ownerResult <- connectErr
	}()
	if _, err := caller.Connect(ownerDescription, true, 20_000); err != nil {
		t.Fatal(err)
	}
	if err := <-ownerResult; err != nil {
		t.Fatal(err)
	}

	serveDone := make(chan error, 1)
	go func() {
		stream, acceptErr := owner.AcceptStream(20_000)
		if acceptErr != nil {
			serveDone <- acceptErr
			return
		}
		defer stream.Close()
		buffer := make([]byte, 1024)
		for {
			count := stream.ReadInto(buffer)
			if count <= 0 {
				serveDone <- io.EOF
				return
			}
			if _, writeErr := stream.Write(buffer[:count]); writeErr != nil {
				serveDone <- writeErr
				return
			}
		}
	}()
	stream, err := caller.OpenStream(20_000)
	if err != nil {
		t.Fatal(err)
	}
	if err := stream.SetDeadline(20_000); err != nil {
		t.Fatal(err)
	}
	payload := []byte("gomobile-authenticated-link")
	if _, err := stream.Write(payload); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, len(payload))
	count := stream.ReadInto(buffer)
	if count != len(payload) {
		t.Fatalf("read count = %d, want %d", count, len(payload))
	}
	got := buffer[:count]
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

func TestProtocolEpochMatchesApplicationPrelude(t *testing.T) {
	if ProtocolEpoch() != ApplicationProtocolEpoch {
		t.Fatalf("ProtocolEpoch() = %d, want %d", ProtocolEpoch(), ApplicationProtocolEpoch)
	}
}

type finalBytesConn struct {
	net.Conn
	remaining []byte
}

func (c *finalBytesConn) Read(buffer []byte) (int, error) {
	if len(c.remaining) == 0 {
		return 0, io.EOF
	}
	count := copy(buffer, c.remaining)
	c.remaining = c.remaining[count:]
	return count, io.EOF
}
