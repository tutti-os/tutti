package conformance

import (
	"context"
	"fmt"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

func runActiveParentSideStaysTransient(
	ctx context.Context,
	driver SideConversationDriver,
) error {
	if err := driver.ResetSideConversation(ctx); err != nil {
		return err
	}
	opened, err := driver.OpenSideConversation(
		ctx,
		agenthost.OpenSideConversationInput{
			WorkspaceID:          "workspace-side",
			SourceAgentSessionID: "parent",
			SideAgentSessionID:   "side-1",
			RequestID:            "open-side-1",
		},
	)
	if err != nil {
		return fmt.Errorf("OpenSideConversation(): %w", err)
	}
	if opened.Session.Scope != agenthost.RuntimeSessionScopeSide ||
		opened.Session.SourceAgentSessionID != "parent" ||
		!opened.Capabilities.ActiveSourceTurn ||
		!opened.Capabilities.Ephemeral {
		return fmt.Errorf("opened side = %#v", opened)
	}
	if _, err := driver.SendSideConversation(
		ctx,
		agenthost.RuntimeExecInput{
			WorkspaceID: "workspace-side", AgentSessionID: "side-1",
			TurnID: "side-turn-1",
			Content: []agenthost.PromptContentBlock{{
				Type: "text", Text: "side question",
			}},
		},
	); err != nil {
		return fmt.Errorf("SendSideConversation(): %w", err)
	}
	beforeSettle := driver.SideConversationMetrics()
	if !beforeSettle.ParentActive || !beforeSettle.SideLive ||
		beforeSettle.CanonicalWrites != 0 ||
		beforeSettle.TransientEvents == 0 {
		return fmt.Errorf("side metrics before parent settle = %#v", beforeSettle)
	}
	if err := driver.SettleSideParent(ctx); err != nil {
		return fmt.Errorf("SettleSideParent(): %w", err)
	}
	afterSettle := driver.SideConversationMetrics()
	if afterSettle.ParentActive || !afterSettle.SideLive ||
		afterSettle.CanonicalWrites != 0 {
		return fmt.Errorf("side metrics after parent settle = %#v", afterSettle)
	}
	if _, err := driver.SendSideConversation(
		ctx,
		agenthost.RuntimeExecInput{
			WorkspaceID: "workspace-side", AgentSessionID: "side-1",
			TurnID: "side-turn-after-parent",
			Content: []agenthost.PromptContentBlock{{
				Type: "text", Text: "side question after parent",
			}},
		},
	); err != nil {
		return fmt.Errorf("SendSideConversation() after parent settle: %w", err)
	}
	if err := driver.CloseSideConversation(
		ctx, "workspace-side", "side-1",
	); err != nil {
		return fmt.Errorf("CloseSideConversation(): %w", err)
	}
	afterClose := driver.SideConversationMetrics()
	if afterClose.ParentActive || afterClose.SideLive ||
		afterClose.CanonicalWrites != 0 {
		return fmt.Errorf("side metrics after close = %#v", afterClose)
	}
	openedAfterParent, err := driver.OpenSideConversation(
		ctx,
		agenthost.OpenSideConversationInput{
			WorkspaceID:          "workspace-side",
			SourceAgentSessionID: "parent",
			SideAgentSessionID:   "side-after-parent",
			RequestID:            "open-side-after-parent",
		},
	)
	if err != nil {
		return fmt.Errorf("OpenSideConversation() after parent settle: %w", err)
	}
	if openedAfterParent.Session.Scope != agenthost.RuntimeSessionScopeSide {
		return fmt.Errorf("opened side after parent settle = %#v", openedAfterParent.Session)
	}
	if err := driver.CloseSideConversation(
		ctx, "workspace-side", "side-after-parent",
	); err != nil {
		return fmt.Errorf("CloseSideConversation() after parent settle: %w", err)
	}
	return nil
}
