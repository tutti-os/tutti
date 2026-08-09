module github.com/tutti-os/tutti/packages/connector/runtime

go 1.24.3

toolchain go1.24.5

require (
	github.com/tutti-os/tutti/packages/agent/daemon v0.0.0
	github.com/tutti-os/tutti/packages/connector/host v0.0.0
	golang.org/x/mod v0.33.0
	gopkg.in/yaml.v3 v3.0.1
)

require (
	github.com/google/uuid v1.6.0 // indirect
	github.com/kr/pretty v0.3.1 // indirect
	github.com/rogpeppe/go-internal v1.14.1 // indirect
	github.com/tutti-os/tutti/packages/agent/activity-replication v0.0.0 // indirect
	github.com/tutti-os/tutti/packages/agent/host v0.0.0 // indirect
	github.com/tutti-os/tutti/packages/agent/session-replay v0.0.0 // indirect
	github.com/tutti-os/tutti/packages/agent/store-sqlite v0.0.0 // indirect
	github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical v0.0.0 // indirect
	golang.org/x/net v0.50.0 // indirect
	golang.org/x/sys v0.41.0 // indirect
	golang.org/x/text v0.34.0 // indirect
	google.golang.org/protobuf v1.36.11 // indirect
	gopkg.in/check.v1 v1.0.0-20201130134442-10cb98267c6c // indirect
)

replace github.com/tutti-os/tutti/packages/agent/daemon => ../../agent/daemon

replace github.com/tutti-os/tutti/packages/agent/activity-replication => ../../agent/activity-replication

replace github.com/tutti-os/tutti/packages/agent/host => ../../agent/host

replace github.com/tutti-os/tutti/packages/agent/session-replay => ../../agent/session-replay

replace github.com/tutti-os/tutti/packages/agent/store-sqlite => ../../agent/store-sqlite

replace github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical => ../../agent/store-sqlite/canonical

replace github.com/tutti-os/tutti/packages/connector/host => ../host

replace google.golang.org/genproto => google.golang.org/genproto v0.0.0-20260120221211-b8f7ae30c516
