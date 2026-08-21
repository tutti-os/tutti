package agentruntime

import (
	"context"
	"encoding/json"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtime/codexproto"
)

func (c *codexAppServerClient) PluginList(
	ctx context.Context,
	timeout time.Duration,
	params map[string]any,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.PluginListParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(timeout, nil, true)
	_, err = client.PluginList(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) SkillsList(
	ctx context.Context,
	timeout time.Duration,
	params map[string]any,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.SkillsListParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(timeout, nil, true)
	_, err = client.SkillsList(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}
