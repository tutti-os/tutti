//go:build !darwin && !linux

package agentruntime

import (
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

func (p *preparedProcessExecutable) Close() error { return nil }
