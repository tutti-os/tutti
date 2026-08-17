// Package connectormcp adapts the public Connector MCP server into the tutt id
// service composition without owning a second transport implementation.
package connectormcp

import connectormcpserver "github.com/tutti-os/tutti/packages/connector/runtime/mcpserver"

type Config = connectormcpserver.Config
type Binding = connectormcpserver.Binding
type Server = connectormcpserver.Server

func Start(config Config) (*Server, error) {
	return connectormcpserver.Start(config)
}
