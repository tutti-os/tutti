module github.com/tutti-os/tutti/packages/agent/host

go 1.24.3

toolchain go1.24.5

require (
	github.com/google/uuid v1.6.0
	github.com/tutti-os/tutti/packages/agent/store-sqlite v0.0.184
	github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical v0.0.184
)

require github.com/tutti-os/tutti/packages/agent/activity-replication v0.0.184 // indirect
