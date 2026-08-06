import { raceSuccessful } from "./pairingTransportRace";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe("raceSuccessful", () => {
  it("returns the first successful path instead of the first settled path", async () => {
    const direct = deferred<string>();
    const relay = deferred<string | null>();
    const result = raceSuccessful([
      { name: "direct", run: () => direct.promise },
      { name: "relay", run: () => relay.promise }
    ]);

    direct.reject(new Error("direct unavailable"));
    relay.resolve("relay-ready");

    await expect(result).resolves.toEqual({
      name: "relay",
      value: "relay-ready"
    });
  });

  it("does not reject when a losing path fails after the winner", async () => {
    const direct = deferred<string>();
    const relay = deferred<string>();
    const result = raceSuccessful([
      { name: "direct", run: () => direct.promise },
      { name: "relay", run: () => relay.promise }
    ]);

    relay.resolve("relay-ready");
    await expect(result).resolves.toEqual({
      name: "relay",
      value: "relay-ready"
    });
    direct.reject(new Error("late direct failure"));
    await Promise.resolve();
  });

  it("rejects only after every path fails or returns null", async () => {
    const result = raceSuccessful([
      { name: "direct", run: async () => null },
      {
        name: "relay",
        run: async () => {
          throw new Error("relay unavailable");
        }
      }
    ]);

    await expect(result).rejects.toThrow("relay unavailable");
  });
});
