package linkmanager

import "sync"

type establishFlight struct {
	done             chan struct{}
	globalGeneration uint64
	keyGeneration    uint64
	once             sync.Once
}

func (m *Manager[K, M]) joinFlight(key K) (*establishFlight, bool, error) {
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return nil, false, ErrManagerClosed
	}
	if !m.enabled {
		m.mu.Unlock()
		return nil, false, ErrManagerDisabled
	}
	if flight := m.flights[key]; flight != nil &&
		flight.globalGeneration == m.globalGeneration &&
		flight.keyGeneration == m.keyGenerations[key] {
		m.mu.Unlock()
		return flight, false, nil
	}
	stale := m.flights[key]
	flight := &establishFlight{
		done:             make(chan struct{}),
		globalGeneration: m.globalGeneration,
		keyGeneration:    m.keyGenerations[key],
	}
	m.flights[key] = flight
	m.mu.Unlock()
	stale.finish()
	return flight, true, nil
}

func (m *Manager[K, M]) finishFlight(key K, flight *establishFlight) {
	m.mu.Lock()
	if m.flights[key] == flight {
		delete(m.flights, key)
	}
	m.mu.Unlock()
	flight.finish()
}

func (flight *establishFlight) finish() {
	if flight == nil {
		return
	}
	flight.once.Do(func() {
		close(flight.done)
	})
}
