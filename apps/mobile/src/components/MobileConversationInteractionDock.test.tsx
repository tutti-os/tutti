import {
  canonicalInteractionKey,
  type AgentActivityInteraction
} from "@tutti-os/agent-activity-core";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MobileConversationInteractionDock } from "./MobileConversationInteractionDock";
import { MobileInteractionCard } from "./MobileConversationRows";

test("renders every pending Interaction with its exact projected state", () => {
  const first = approvalInteraction("first");
  const second = approvalInteraction("second");
  const secondKey = canonicalInteractionKey(
    second.agentSessionId,
    second.turnId,
    second.requestId
  );
  const responses: Array<{
    interaction: AgentActivityInteraction;
    input: Readonly<Record<string, unknown>>;
  }> = [];
  let renderer: ReactTestRenderer;

  act(() => {
    renderer = create(
      <MobileConversationInteractionDock
        interactionStates={{
          [secondKey]: {
            failed: true,
            runtimeAvailable: true,
            submitting: false
          }
        }}
        interactions={[first, second]}
        onRespond={(interaction, input) =>
          responses.push({ interaction, input })
        }
      />
    );
  });

  const cards = renderer!.root.findAllByType(MobileInteractionCard);
  expect(cards).toHaveLength(2);
  expect(cards[0]?.props.runtimeAvailable).toBe(false);
  expect(cards[1]?.props.failed).toBe(true);
  expect(cards[1]?.props.runtimeAvailable).toBe(true);

  act(() => cards[1]?.props.onSubmit({ optionId: "allow-once" }));
  expect(responses).toEqual([
    { interaction: second, input: { optionId: "allow-once" } }
  ]);
});

test("does not reserve dock space when there are no pending Interactions", () => {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MobileConversationInteractionDock
        interactionStates={{}}
        interactions={[]}
        onRespond={() => undefined}
      />
    );
  });
  expect(renderer!.toJSON()).toBeNull();
});

function approvalInteraction(suffix: string): AgentActivityInteraction {
  return {
    agentSessionId: "session-1",
    createdAtUnixMs: 1,
    input: {
      callId: `call-${suffix}`,
      options: [{ label: "Allow", optionId: "allow-once" }]
    },
    kind: "approval",
    metadata: {},
    output: null,
    requestId: `request-${suffix}`,
    status: "pending",
    toolName: "Approval",
    turnId: `turn-${suffix}`,
    updatedAtUnixMs: 1
  };
}
