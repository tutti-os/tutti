module github.com/tutti-os/tutti/packages/clients/connector-controlplane

go 1.24.3

toolchain go1.24.5

require (
	github.com/coder/websocket v1.8.14
	github.com/tutti-os/tutti/packages/connector/host v0.0.0
)

replace github.com/tutti-os/tutti/packages/connector/host => ../../connector/host
