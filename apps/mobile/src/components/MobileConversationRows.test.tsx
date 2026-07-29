import type { AgentActivityInteraction } from "@tutti-os/agent-activity-core";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Text } from "react-native";
import { PrimaryButton } from "./PrimaryButton";
import { MobileInteractionCard } from "./MobileConversationRows";

test("renders Engine-owned submitting and failure state", () => {
  let retries = 0;
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MobileInteractionCard
        failed
        interaction={approvalInteraction()}
        onRetry={() => {
          retries += 1;
        }}
        onSubmit={() => undefined}
        runtimeAvailable
        submitting={false}
      />
    );
  });

  const retry = renderer!.root.findByType(PrimaryButton);
  expect(retry.props.disabled).toBe(false);
  expect(retry.props.label).toBe("Retry");
  act(() => retry.props.onPress());
  expect(retries).toBe(1);
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
        onRetry={() => undefined}
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
      options: [{ label: "Allow", optionId: "allow-once" }]
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
