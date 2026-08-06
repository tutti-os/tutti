import {
  MOBILE_UPDATE_SCHEMA_VERSION,
  MobileUpdateService,
  parseMobileUpdateRelease
} from "./mobileUpdateService";

const releaseFeed = {
  apkUrl: "https://downloads.example.test/mobile-v0.1.1.apk",
  mandatory: false,
  packageName: "sh.tutti.mobile",
  releasedAt: "2026-08-06T00:00:00.000Z",
  schemaVersion: MOBILE_UPDATE_SCHEMA_VERSION,
  sha256: "a".repeat(64),
  sizeBytes: 1024,
  tag: "tutti-mobile-v0.1.1",
  versionCode: 2,
  versionName: "0.1.1"
};

test("checks the pointer and exposes a newer release", async () => {
  const service = createService(releaseFeed);

  const snapshot = await service.checkForUpdates();

  expect(snapshot.status).toBe("available");
  expect(snapshot.release).toMatchObject({
    apkURL: releaseFeed.apkUrl,
    tag: releaseFeed.tag,
    versionCode: 2,
    versionName: "0.1.1"
  });
  expect(snapshot.checkedAt).toBe("2026-08-06T01:00:00.000Z");
});

test("does not offer an older or equal release", async () => {
  const service = createService({ ...releaseFeed, versionCode: 1 });

  const snapshot = await service.checkForUpdates();

  expect(snapshot.status).toBe("upToDate");
  expect(snapshot.release).toBeNull();
});

test("passes the verified release to the native installer", async () => {
  const install = jest.fn<Promise<void>, [string, string]>(
    async () => undefined
  );
  const service = createService(releaseFeed, install);

  await service.checkForUpdates();
  const snapshot = await service.installUpdate();

  expect(install).toHaveBeenCalledWith(releaseFeed.apkUrl, "a".repeat(64));
  expect(snapshot.status).toBe("installing");
});

test("rejects a feed for a different package or schema", () => {
  expect(() =>
    parseMobileUpdateRelease({ ...releaseFeed, packageName: "other.app" })
  ).toThrow("package name");
  expect(() =>
    parseMobileUpdateRelease({ ...releaseFeed, schemaVersion: "unknown" })
  ).toThrow("schema");
  expect(() =>
    parseMobileUpdateRelease({ ...releaseFeed, tag: "tutti-mobile-v0.1.0" })
  ).toThrow("tag");
});

test("reports unsupported when no native installer is available", async () => {
  const service = new MobileUpdateService({
    currentVersionCode: 1,
    currentVersionName: "0.1.0",
    feedURL: "https://updates.example.test/latest.json"
  });

  expect((await service.checkForUpdates()).status).toBe("unsupported");
});

function createService(
  payload: unknown,
  install: (apkURL: string, sha256: string) => Promise<void> = async () =>
    undefined
): MobileUpdateService {
  return new MobileUpdateService({
    currentVersionCode: 1,
    currentVersionName: "0.1.0",
    feedURL: "https://updates.example.test/latest.json",
    fetch: async () =>
      ({
        json: async () => payload,
        ok: true,
        status: 200
      }) as Response,
    installer: { install },
    now: () => new Date("2026-08-06T01:00:00.000Z")
  });
}
