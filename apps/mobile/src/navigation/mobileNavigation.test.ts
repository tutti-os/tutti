import type { WorkspaceSummary } from "@tutti-os/client-tuttid-ts";
import type { AccountSession } from "../services/mobileDomain";
import {
  availableMobileRoutes,
  shouldExitConversationRoute
} from "./mobileNavigation";

const session: AccountSession = {
  email: "person@example.com",
  name: "Person",
  sessionId: "session-cookie",
  userId: "user-1"
};
const workspace: WorkspaceSummary = {
  id: "workspace-1",
  lastOpenedAt: null,
  name: "Personal"
};

describe("mobile navigation access", () => {
  test("exposes only Login before authentication", () => {
    expect(availableMobileRoutes({ status: "unauthenticated" })).toEqual([
      "Login"
    ]);
  });

  test("uses Devices as the authenticated root without a workspace route", () => {
    expect(
      availableMobileRoutes({
        device: null,
        session,
        status: "authenticated",
        workspace: null
      })
    ).toEqual(["Devices"]);
  });

  test("opens conversation routes only after the Personal workspace resolves", () => {
    expect(
      availableMobileRoutes({
        device: { name: "Desktop", pairingId: "pairing-1" },
        session,
        status: "authenticated",
        workspace
      })
    ).toEqual(["Devices", "Conversations", "Conversation"]);
  });
});

describe("conversation route ownership", () => {
  test("exits a focused route after its selected session disappears", () => {
    expect(
      shouldExitConversationRoute({
        focused: true,
        loading: false,
        routeAgentSessionId: "session-1",
        selectedAgentSessionId: "session-1",
        selectedSessionPresent: false
      })
    ).toBe(true);
  });

  test("does not react to stale model state while another route gains focus", () => {
    expect(
      shouldExitConversationRoute({
        focused: true,
        loading: false,
        routeAgentSessionId: "session-1",
        selectedAgentSessionId: "session-2",
        selectedSessionPresent: true
      })
    ).toBe(false);
  });

  test("keeps the creating route open without a selected session", () => {
    expect(
      shouldExitConversationRoute({
        focused: true,
        loading: false,
        routeAgentSessionId: null,
        selectedAgentSessionId: null,
        selectedSessionPresent: false
      })
    ).toBe(false);
  });
});
