// Package mcp preserves the tuttId-local import during the public MCP client
// extraction. New consumers should import packages/connector/runtime/mcp.
package mcp

import runtimemcp "github.com/tutti-os/tutti/packages/connector/runtime/mcp"

type RPCError = runtimemcp.RPCError
type ServerRequest = runtimemcp.ServerRequest
type Notification = runtimemcp.Notification
type ServerRequestHandler = runtimemcp.ServerRequestHandler
type NotificationHandler = runtimemcp.NotificationHandler
type StdioClientConfig = runtimemcp.StdioClientConfig
type StdioClient = runtimemcp.StdioClient

var NewStdioClient = runtimemcp.NewStdioClient
