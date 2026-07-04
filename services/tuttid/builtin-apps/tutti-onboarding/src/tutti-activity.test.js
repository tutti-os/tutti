import { afterEach, describe, expect, it, vi } from "vitest";

import { reportUserActive, reportUserActiveOnce } from "./tutti-activity.js";

describe("tutti activity bridge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports user activity through the host bridge", async () => {
    const reportActive = vi.fn(async () => undefined);
    vi.stubGlobal("window", { tuttiExternal: { activity: { reportActive } } });

    reportUserActive();
    await Promise.resolve();

    expect(reportActive).toHaveBeenCalledTimes(1);
  });

  it("reports only once when using the once helper", async () => {
    const reportActive = vi.fn(async () => undefined);
    vi.stubGlobal("window", { tuttiExternal: { activity: { reportActive } } });

    reportUserActiveOnce();
    reportUserActiveOnce();
    await Promise.resolve();

    expect(reportActive).toHaveBeenCalledTimes(1);
  });
});
