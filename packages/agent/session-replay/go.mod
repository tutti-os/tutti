module github.com/tutti-os/tutti/packages/agent/session-replay

go 1.24.3

toolchain go1.24.5

require (
	github.com/google/uuid v1.6.0
	github.com/tutti-os/tutti/packages/agent/host v0.0.0
	github.com/tutti-os/tutti/packages/agent/store-sqlite v0.0.0
)

replace github.com/tutti-os/tutti/packages/agent/host => ../host

replace github.com/tutti-os/tutti/packages/agent/store-sqlite => ../store-sqlite
