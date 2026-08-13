module github.com/tutti-os/tutti/packages/device-link

go 1.24.3

toolchain go1.24.5

require (
	github.com/gorilla/websocket v1.5.3
	github.com/hashicorp/yamux v0.1.2
	github.com/pion/ice/v4 v4.2.7
	github.com/pion/logging v0.2.4
	github.com/pion/stun/v3 v3.1.4
	github.com/pion/transport/v4 v4.0.2
	github.com/quic-go/quic-go v0.59.0
	golang.org/x/net v0.50.0
	golang.org/x/sys v0.41.0
)

require (
	github.com/davecgh/go-spew v1.1.2-0.20180830191138-d8f796af33cc // indirect
	github.com/google/go-cmp v0.7.0 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/pion/dtls/v3 v3.1.3 // indirect
	github.com/pion/mdns/v2 v2.1.0 // indirect
	github.com/pion/randutil v0.1.0 // indirect
	github.com/pion/turn/v5 v5.0.7 // indirect
	github.com/pmezard/go-difflib v1.0.1-0.20181226105442-5d4384ee4fb2 // indirect
	github.com/wlynxg/anet v0.0.5 // indirect
	golang.org/x/crypto v0.48.0 // indirect
	golang.org/x/mobile v0.0.0-20251209145715-2553ed8ce294 // indirect
	golang.org/x/mod v0.33.0 // indirect
	golang.org/x/sync v0.19.0 // indirect
	golang.org/x/time v0.14.0 // indirect
	golang.org/x/tools v0.42.0 // indirect
)

tool (
	golang.org/x/mobile/cmd/gobind
	golang.org/x/mobile/cmd/gomobile
)
