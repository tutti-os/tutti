package implementationhost

import (
	"testing"
	"time"
)

func TestConnectorLifecycleLanesSerializePerConnectorAndAllowCrossConnectorConcurrency(t *testing.T) {
	host := &Host{}
	releaseA := host.enterConnectorLane("alpha")

	bAcquired := make(chan func(), 1)
	go func() { bAcquired <- host.enterConnectorLane("beta") }()
	select {
	case releaseB := <-bAcquired:
		releaseB()
	case <-time.After(time.Second):
		t.Fatal("unrelated connector lane was globally serialized")
	}

	secondA := make(chan func(), 1)
	go func() { secondA <- host.enterConnectorLane("alpha") }()
	select {
	case release := <-secondA:
		release()
		t.Fatal("same connector lane was entered concurrently")
	case <-time.After(25 * time.Millisecond):
	}
	releaseA()
	select {
	case release := <-secondA:
		release()
	case <-time.After(time.Second):
		t.Fatal("same connector lane did not resume after release")
	}
}
