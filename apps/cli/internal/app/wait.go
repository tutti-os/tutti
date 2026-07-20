package app

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/tutti-os/tutti/apps/cli/internal/daemon"
)

const appHandlerRequestTimeoutMargin = 30 * time.Second

type waitOptions struct {
	timeout time.Duration
	set     bool
}

func isWaitCommand(command daemon.Capability) bool {
	return command.Execution != nil && command.Execution.Mode == "wait"
}

func waitCommandFlags(command daemon.Capability, flags []commandFlag) []commandFlag {
	if !isWaitCommand(command) {
		return flags
	}
	for _, flag := range flags {
		if flag.Name == "timeout-ms" {
			return flags
		}
	}
	return append(flags, commandFlag{
		Name: "timeout-ms", Type: "integer",
		Description: "Maximum total wait in milliseconds; omit to wait until the command reaches a stop point.",
	})
}

func parseWaitOptions(command daemon.Capability, args []string) (waitOptions, []string, error) {
	if !isWaitCommand(command) {
		return waitOptions{}, args, nil
	}
	filtered := make([]string, 0, len(args))
	var options waitOptions
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if arg != "--timeout-ms" && !strings.HasPrefix(arg, "--timeout-ms=") {
			filtered = append(filtered, arg)
			continue
		}
		if options.set {
			return waitOptions{}, nil, errors.New("--timeout-ms may only be provided once")
		}
		value := ""
		if _, inline, found := strings.Cut(arg, "="); found {
			value = inline
		} else {
			if index+1 >= len(args) || strings.HasPrefix(args[index+1], "--") {
				return waitOptions{}, nil, errors.New("missing value for --timeout-ms")
			}
			index++
			value = args[index]
		}
		milliseconds, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		if err != nil || milliseconds <= 0 || milliseconds > int64(^uint64(0)>>1)/int64(time.Millisecond) {
			return waitOptions{}, nil, fmt.Errorf("invalid --timeout-ms value %q: expected a positive integer", value)
		}
		options = waitOptions{timeout: time.Duration(milliseconds) * time.Millisecond, set: true}
	}
	return options, filtered, nil
}

func invokeDynamicCommand(
	ctx context.Context,
	client *daemon.Client,
	command daemon.Capability,
	request daemon.InvokeRequest,
	options waitOptions,
) (daemon.InvokeResponse, error) {
	if !isWaitCommand(command) {
		return invokeOnce(ctx, client, command, request)
	}

	waitCtx := ctx
	var cancel context.CancelFunc
	if options.set {
		waitCtx, cancel = context.WithTimeout(ctx, options.timeout)
		defer cancel()
	}

	var lastOutput *daemon.CommandOutput
	for {
		response, err := invokeOnce(waitCtx, client, command, request)
		if err != nil {
			if options.set && errors.Is(waitCtx.Err(), context.DeadlineExceeded) {
				return waitTimedOutResponse(lastOutput), nil
			}
			return daemon.InvokeResponse{}, err
		}
		if response.Output == nil || response.Output.Continuation == nil {
			return response, nil
		}
		lastOutput = response.Output
		delay := time.Duration(response.Output.Continuation.RetryAfterMs) * time.Millisecond
		timer := time.NewTimer(delay)
		select {
		case <-waitCtx.Done():
			timer.Stop()
			if options.set && errors.Is(waitCtx.Err(), context.DeadlineExceeded) {
				return waitTimedOutResponse(lastOutput), nil
			}
			return daemon.InvokeResponse{}, waitCtx.Err()
		case <-timer.C:
		}
	}
}

func invokeOnce(ctx context.Context, client *daemon.Client, command daemon.Capability, request daemon.InvokeRequest) (daemon.InvokeResponse, error) {
	if command.HandlerTimeoutMs <= 0 {
		return client.Invoke(ctx, command.ID, request)
	}
	timeout := time.Duration(command.HandlerTimeoutMs)*time.Millisecond + appHandlerRequestTimeoutMargin
	return client.InvokeWithTimeout(ctx, command.ID, request, timeout)
}

func waitTimedOutResponse(lastOutput *daemon.CommandOutput) daemon.InvokeResponse {
	value := map[string]any{
		"reason":             "wait_timeout",
		"timedOut":           true,
		"executionContinues": true,
	}
	if lastOutput != nil {
		switch {
		case len(lastOutput.Value) > 0:
			value["lastResult"] = lastOutput.Value
		case lastOutput.Rows != nil:
			value["lastResult"] = lastOutput.Rows
		case strings.TrimSpace(lastOutput.Text) != "":
			value["lastResult"] = lastOutput.Text
		}
	}
	return daemon.InvokeResponse{
		OK:     true,
		Output: &daemon.CommandOutput{Kind: "json", Value: value},
	}
}
