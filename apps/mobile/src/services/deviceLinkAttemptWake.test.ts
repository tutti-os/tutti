import { DeviceLinkAttemptWake } from "./deviceLinkAttemptWake";

describe("DeviceLinkAttemptWake", () => {
  it("observes notifications that arrive before waiting", async () => {
    const wake = new DeviceLinkAttemptWake();
    wake.notify("attempt-1");
    await expect(
      wake.wait("attempt-1", 0, new AbortController().signal)
    ).resolves.toBe(true);
  });

  it("cancels a pending wait", async () => {
    const wake = new DeviceLinkAttemptWake();
    const controller = new AbortController();
    const waiting = wake.wait("attempt-1", 0, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBe(false);
  });
});
