import type {
  AgentQuickPrompt,
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
  test("loads the canonical device prompt order", async () => {
    const service = new MobileQuickPromptLibraryService(
      createClient({
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

  test("reports a prompt-list request failure", async () => {
    const service = new MobileQuickPromptLibraryService({
      listAgentQuickPrompts: jest
        .fn()
        .mockRejectedValue(new Error("unavailable"))
    } as unknown as TuttidClient);

    await service.refresh();

    expect(service.getSnapshot()).toEqual({
      enabled: true,
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
  listAgentQuickPrompts: jest.Mock;
}): TuttidClient {
  return {
    listAgentQuickPrompts: input.listAgentQuickPrompts
  } as unknown as TuttidClient;
}
