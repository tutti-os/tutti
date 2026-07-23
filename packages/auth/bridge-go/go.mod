module github.com/tutti-os/tutti/packages/auth/bridge-go

go 1.24.3

require github.com/tutti-os/tutti/packages/agent/daemon v0.0.0

require (
	golang.org/x/net v0.50.0 // indirect
	golang.org/x/text v0.34.0 // indirect
)

replace github.com/tutti-os/tutti/packages/agent/daemon => ../../agent/daemon
