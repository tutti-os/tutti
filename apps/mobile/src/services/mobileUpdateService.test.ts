import {
  MOBILE_UPDATE_INSTALL_PERMISSION_REQUIRED,
  MAX_MOBILE_UPDATE_BYTES,
  MOBILE_UPDATE_SCHEMA_VERSION,
  type MobileUpdateInstaller,
  type MobileUpdateProgress,
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
  const install = jest.fn<Promise<void>, [string, string, number, number]>(
    async () => undefined
  );
  const service = createService(releaseFeed, install);

  await service.checkForUpdates();
  const snapshot = await service.installUpdate();

  expect(install).toHaveBeenCalledWith(
    releaseFeed.apkUrl,
    "a".repeat(64),
    releaseFeed.sizeBytes,
    releaseFeed.versionCode
  );
  expect(snapshot.status).toBe("installing");
  await service.installUpdate();
  expect(install).toHaveBeenCalledTimes(1);
});

test("keeps the release available when Android install permission is required", async () => {
  const install = jest.fn<Promise<void>, [string, string, number, number]>(
    async () => {
      throw { code: MOBILE_UPDATE_INSTALL_PERMISSION_REQUIRED };
    }
  );
  const service = createService(releaseFeed, install);

  await service.checkForUpdates();
  await expect(service.installUpdate()).rejects.toMatchObject({
    code: MOBILE_UPDATE_INSTALL_PERMISSION_REQUIRED
  });

  expect(service.getSnapshot().status).toBe("available");
});

test("publishes native download progress and cancels the active update", async () => {
  let publish: ((progress: MobileUpdateProgress) => void) | undefined;
  const installer: MobileUpdateInstaller = {
    cancel: jest.fn(async () => undefined),
    install: jest.fn(() => new Promise(() => undefined)),
    subscribe: (listener) => {
      publish = listener;
      return () => undefined;
    }
  };
  const service = createService(releaseFeed, installer);

  await service.checkForUpdates();
  void service.installUpdate();
  publish?.({
    downloadedBytes: 512,
    errorCode: null,
    indeterminate: false,
    phase: "downloading",
    totalBytes: 1024
  });

  expect(service.getSnapshot()).toMatchObject({
    progress: { downloadedBytes: 512, phase: "downloading" },
    status: "installing"
  });
  await service.cancelUpdate();
  expect(installer.cancel).toHaveBeenCalledTimes(1);
  expect(service.getSnapshot()).toMatchObject({
    progress: null,
    status: "available"
  });
});

test("ignores late download progress after cancellation", async () => {
  let publish: ((progress: MobileUpdateProgress) => void) | undefined;
  const installer: MobileUpdateInstaller = {
    cancel: jest.fn(async () => undefined),
    install: jest.fn(() => new Promise(() => undefined)),
    subscribe: (listener) => {
      publish = listener;
      return () => undefined;
    }
  };
  const service = createService(releaseFeed, installer);

  await service.checkForUpdates();
  void service.installUpdate();
  await service.cancelUpdate();
  publish?.({
    downloadedBytes: 768,
    errorCode: null,
    indeterminate: false,
    phase: "downloading",
    totalBytes: 1024
  });

  expect(service.getSnapshot()).toMatchObject({
    progress: null,
    status: "available"
  });
});

test("surfaces a package installer failure after handoff", async () => {
  let publish: ((progress: MobileUpdateProgress) => void) | undefined;
  const service = createService(releaseFeed, {
    cancel: async () => undefined,
    install: async () => undefined,
    subscribe: (listener) => {
      publish = listener;
      return () => undefined;
    }
  });

  await service.checkForUpdates();
  await service.installUpdate();
  publish?.({
    downloadedBytes: 0,
    errorCode: "UPDATE_INSTALL_CONFLICT",
    indeterminate: true,
    phase: "failed",
    totalBytes: null
  });

  expect(service.getSnapshot()).toMatchObject({
    installationFailureCode: "UPDATE_INSTALL_CONFLICT",
    progress: null,
    status: "error"
  });
  service.acknowledgeInstallationFailure();
  expect(service.getSnapshot()).toMatchObject({
    installationFailureCode: null,
    status: "available"
  });
});

test("deduplicates concurrent installation requests", async () => {
  let complete: (() => void) | undefined;
  const install = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      })
  );
  const service = createService(releaseFeed, install);

  await service.checkForUpdates();
  const first = service.installUpdate();
  const second = service.installUpdate();
  complete?.();

  await expect(first).resolves.toMatchObject({ status: "installing" });
  await expect(second).resolves.toMatchObject({ status: "installing" });
  expect(install).toHaveBeenCalledTimes(1);
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
  expect(() =>
    parseMobileUpdateRelease({ ...releaseFeed, sizeBytes: null })
  ).toThrow("sizeBytes");
  expect(() =>
    parseMobileUpdateRelease({
      ...releaseFeed,
      sizeBytes: MAX_MOBILE_UPDATE_BYTES + 1
    })
  ).toThrow("supported limit");
  expect(() =>
    parseMobileUpdateRelease({
      ...releaseFeed,
      apkUrl: "https://user:secret@downloads.example.test/mobile.apk"
    })
  ).toThrow("credential-free HTTPS");
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
  installerOrInstall:
    | MobileUpdateInstaller
    | ((
        apkURL: string,
        sha256: string,
        sizeBytes: number,
        targetVersionCode: number
      ) => Promise<void>) = async () => undefined
): MobileUpdateService {
  const installer: MobileUpdateInstaller =
    typeof installerOrInstall === "function"
      ? {
          cancel: async () => undefined,
          install: installerOrInstall,
          subscribe: () => () => undefined
        }
      : installerOrInstall;
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
    installer,
    now: () => new Date("2026-08-06T01:00:00.000Z")
  });
}
