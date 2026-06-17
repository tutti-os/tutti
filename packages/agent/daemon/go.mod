module github.com/tutti-os/tutti/packages/agentactivity/daemon

go 1.24.3

toolchain go1.24.5

require (
	google.golang.org/grpc v1.80.0
	google.golang.org/protobuf v1.36.11
)

require (
	golang.org/x/net v0.50.0 // indirect
	golang.org/x/sys v0.41.0 // indirect
	golang.org/x/text v0.34.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260120221211-b8f7ae30c516 // indirect
)

replace google.golang.org/genproto => google.golang.org/genproto v0.0.0-20260120221211-b8f7ae30c516
