import type { AgentActivityInteraction } from "@tutti-os/agent-activity-core";
import type { AgentConversationVM } from "@tutti-os/agent-gui/conversation-projection";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Text } from "react-native";
import { PrimaryButton } from "./PrimaryButton";
import { MobileInteractionCard } from "./MobileConversationRows";
import { MobileConversationTimeline } from "./MobileConversationTimeline";

test("renders context overflow with new-conversation handoff guidance", () => {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MobileConversationTimeline
        conversation={
          {
            rows: [
              {
                kind: "message",
                id: "row-handoff-required",
                turnId: "turn-handoff-required",
                speaker: "assistant",
                occurredAtUnixMs: 1,
                thinking: [],
                messages: [
                  {
                    kind: "message-content",
                    id: "message-handoff-required",
                    turnId: "turn-handoff-required",
                    body: "",
                    presentationKind: "turn-boundary",
                    occurredAtUnixMs: 1,
                    systemNotice: {
                      noticeKind: "context_handoff_required",
                      semanticKind: "context-handoff-required",
                      severity: "error",
                      command: "compact",
                      commandStatus: "failed",
                      title: "Context compaction interrupted.",
                      detail: "Maximum context length exceeded.",
                      retryable: false
                    }
                  }
                ]
              }
            ]
          } as unknown as AgentConversationVM
        }
        media={{ loadingImageIds: [], sourcesByImageId: {} }}
        onLinkPress={() => false}
      />
    );
  });

  const text = renderer!.root
    .findAllByType(Text)
    .map((node) => String(node.props.children))
    .join("\n");
  expect(text).toContain("This conversation has reached its context limit");
  expect(text).toContain("@mention this conversation");
  expect(text).toContain("Maximum context length exceeded.");
});

test("keeps the explicit Interaction choices available after a failed response", () => {
  const submissions: Record<string, unknown>[] = [];
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MobileInteractionCard
        failed
        interaction={approvalInteraction()}
        onSubmit={(input) => {
          submissions.push(input);
        }}
        runtimeAvailable
        submitting={false}
      />
    );
  });

  const option = renderer!.root.findByType(PrimaryButton);
  expect(option.props.disabled).toBe(false);
  expect(option.props.label).toBe("Allow");
  expect(option.props.accessibilityLabel).toBe("Allow. Run this command once");
  act(() => option.props.onPress());
  expect(submissions).toEqual([{ optionId: "allow-once" }]);
  expect(
    renderer!.root
      .findAllByType(Text)
      .some((node) => String(node.props.children).includes("Something went"))
  ).toBe(true);
});

test("fails closed when an exit-plan Interaction has no runtime-authored options", () => {
  let submissions = 0;
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MobileInteractionCard
        failed={false}
        interaction={{
          ...approvalInteraction(),
          input: {},
          kind: "plan",
          toolName: "ExitPlanMode"
        }}
        onSubmit={() => {
          submissions += 1;
        }}
        runtimeAvailable
        submitting={false}
      />
    );
  });

  expect(renderer!.root.findAllByType(PrimaryButton)).toHaveLength(0);
  expect(submissions).toBe(0);
});

function approvalInteraction(): AgentActivityInteraction {
  return {
    agentSessionId: "session-1",
    createdAtUnixMs: 1,
    input: {
      callId: "call-1",
      options: [
        {
          description: "Run this command once",
          label: "Allow",
          optionId: "allow-once"
        }
      ]
    },
    kind: "approval",
    metadata: {},
    output: null,
    requestId: "request-1",
    status: "pending",
    toolName: "Approval",
    turnId: "turn-1",
    updatedAtUnixMs: 1
  };
}
