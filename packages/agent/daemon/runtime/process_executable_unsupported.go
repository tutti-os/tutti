//go:build !darwin && !linux && !windows

package agentruntime

import (
	"context"
	"errors"
	"os"
)

type preparedProcessExecutable struct {
	path string
	file *os.File
}

func prepareProcessExecutable(path string, expected *ExecutableIdentity) (preparedProcessExecutable, error) {
	if expected != nil {
		return preparedProcessExecutable{}, errors.New("verified descriptor process start is unavailable on this platform")
	}
	return preparedProcessExecutable{path: path}, nil
}

func prepareReusableNodeInterpreter(
	ctx context.Context,
	_ *VerifiedNodeScriptRunner,
	path string,
	expected *ExecutableIdentity,
) (preparedProcessExecutable, error) {
	if err := ctx.Err(); err != nil {
		return preparedProcessExecutable{}, err
	}
	return prepareProcessExecutable(path, expected)
}

func (p *preparedProcessExecutable) Close() error { return nil }
