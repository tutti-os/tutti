import type {
  AgentQuickPrompt,
  DesktopPreferencesStateResponse,
  TuttidClient
} from "@tutti-os/client-tuttid-ts";
import { MobileQuickPromptLibraryService } from "./mobileQuickPromptLibraryService";

const prompt: AgentQuickPrompt = {
  content: "Review the current change",
  createdAtUnixMs: 1,
  id: "prompt-1",
  title: "Review",
  updatedAtUnixMs: 2,
  version: 1
};

describe("MobileQuickPromptLibraryService", () => {
  test("keeps the library hidden without the desktop feature flag", async () => {
    const listAgentQuickPrompts = jest.fn();
    const service = new MobileQuickPromptLibraryService(
      createClient({
        featureFlags: {},
        listAgentQuickPrompts
      })
    );

    await service.refresh();

    expect(listAgentQuickPrompts).not.toHaveBeenCalled();
    expect(service.getSnapshot()).toEqual({
      enabled: false,
      errorCode: null,
      prompts: [],
      status: "ready"
    });
  });

  test("loads the canonical device prompt order when enabled", async () => {
    const service = new MobileQuickPromptLibraryService(
      createClient({
        featureFlags: { "agent.quickPromptLibrary": true },
        listAgentQuickPrompts: jest
          .fn()
          .mockResolvedValue({ prompts: [prompt] })
      })
    );

    await service.refresh();

    expect(service.getSnapshot()).toEqual({
      enabled: true,
      errorCode: null,
      prompts: [prompt],
      status: "ready"
    });
  });

  test("fails closed when desktop preferences cannot be read", async () => {
    const service = new MobileQuickPromptLibraryService({
      getDesktopPreferences: jest
        .fn()
        .mockRejectedValue(new Error("unavailable")),
      listAgentQuickPrompts: jest.fn()
    } as unknown as TuttidClient);

    await service.refresh();

    expect(service.getSnapshot()).toEqual({
      enabled: false,
      errorCode: "request_failed",
      prompts: [],
      status: "error"
    });
  });

  test("retains the last list when an enabled refresh fails", async () => {
    const listAgentQuickPrompts = jest
      .fn()
      .mockResolvedValueOnce({ prompts: [prompt] })
      .mockRejectedValueOnce(new Error("unavailable"));
    const service = new MobileQuickPromptLibraryService(
      createClient({
        featureFlags: { "agent.quickPromptLibrary": true },
        listAgentQuickPrompts
      })
    );
    await service.refresh();

    await service.refresh();

    expect(service.getSnapshot()).toEqual({
      enabled: true,
      errorCode: "request_failed",
      prompts: [prompt],
      status: "error"
    });
  });

  test("reset fences an in-flight list before another device refresh", async () => {
    let resolveFirstList = (_value: { prompts: AgentQuickPrompt[] }): void => {
      throw new Error("first list resolver is unavailable");
    };
    const firstList = new Promise<{ prompts: AgentQuickPrompt[] }>(
      (resolve) => {
        resolveFirstList = resolve;
      }
    );
    const listAgentQuickPrompts = jest
      .fn()
      .mockReturnValueOnce(firstList)
      .mockResolvedValueOnce({ prompts: [] });
    const service = new MobileQuickPromptLibraryService(
      createClient({
        featureFlags: { "agent.quickPromptLibrary": true },
        listAgentQuickPrompts
      })
    );
    const staleRefresh = service.refresh();
    await Promise.resolve();

    service.reset();
    await service.refresh();
    resolveFirstList({ prompts: [prompt] });
    await staleRefresh;

    expect(service.getSnapshot()).toEqual({
      enabled: true,
      errorCode: null,
      prompts: [],
      status: "ready"
    });
  });
});

function createClient(input: {
  featureFlags: Record<string, boolean>;
  listAgentQuickPrompts: jest.Mock;
}): TuttidClient {
  return {
    getDesktopPreferences: async () =>
      ({
        initialized: true,
        preferences: {
          featureFlags: input.featureFlags
        }
      }) as DesktopPreferencesStateResponse,
    listAgentQuickPrompts: input.listAgentQuickPrompts
  } as unknown as TuttidClient;
}
