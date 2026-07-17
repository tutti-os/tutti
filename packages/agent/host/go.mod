module github.com/tutti-os/tutti/packages/agent/host

go 1.24.3

toolchain go1.24.5

require (
	github.com/google/uuid v1.6.0
	github.com/tutti-os/tutti/packages/agent/daemon v0.0.0
	github.com/tutti-os/tutti/packages/agent/store-sqlite v0.0.0
	github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical v0.0.0
)

require (
	golang.org/x/net v0.50.0 // indirect
	golang.org/x/text v0.34.0 // indirect
)

replace github.com/tutti-os/tutti/packages/agent/activity-replication => ../activity-replication

replace github.com/tutti-os/tutti/packages/agent/daemon => ../daemon

replace github.com/tutti-os/tutti/packages/agent/store-sqlite => ../store-sqlite

replace github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical => ../store-sqlite/canonical
