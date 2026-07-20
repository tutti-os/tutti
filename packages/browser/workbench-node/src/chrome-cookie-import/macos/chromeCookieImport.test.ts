import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  ChromeCookieImportError,
  classifyChromeKeychainFailure,
  decryptChromeV10CookieForTesting,
  discoverChromeCookieProfiles,
  prepareChromeCookies,
  withChromeCookieDatabaseSnapshot
} from "./chromeCookieImport.ts";

const NOW_MS = Date.UTC(2026, 0, 1);
const FUTURE_CHROME_TIME = String(
  BigInt(Math.floor(NOW_MS / 1000) + 3_600 + 11_644_473_600) * 1_000_000n
);
const PAST_CHROME_TIME = String(
  BigInt(Math.floor(NOW_MS / 1000) - 3_600 + 11_644_473_600) * 1_000_000n
);

interface CookieFixture {
  encryptedValue?: Buffer;
  expiresUtc?: string;
  hasExpires?: number;
  hostKey?: string;
  httpOnly?: number;
  isPartitioned?: number;
  name?: string;
  partitionKey?: string;
  path?: string;
  persistent?: number;
  sameSite?: number;
  secure?: number;
  topFrameSiteKey?: string;
  value?: string;
}

test("discovers renderer-safe metadata for all Local State profiles with old and new Cookie DB paths", async (t) => {
  const root = await chromeRoot(t);
  await createProfileDatabase(root, "Default", [], 24, "new");
  await createProfileDatabase(root, "Profile 1", [], 24, "old");
  await createProfileDatabase(root, "Profile 2", [], 24, "new");
  const avatarBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  await writeFile(
    join(root, "Default", "Google Profile Picture.png"),
    avatarBytes
  );
  await writeFile(join(root, "Profile 2", "Avatar.png"), "not-an-image");
  await writeLocalState(root, {
    Default: {
      avatar_icon: "chrome://theme/IDR_PROFILE_AVATAR_7",
      name: "Personal",
      user_name: "person@example.com"
    },
    "Profile 1": { gaia_name: "Work account" },
    "Profile 2": {
      avatar_icon: "file:///Users/secret/avatar.png",
      name: "No unsafe avatar"
    },
    "System Profile": { name: "System" },
    "../outside": { name: "Traversal" }
  });

  const profiles = await discoverChromeCookieProfiles(dependencies(root));

  assert.equal(profiles.length, 3);
  assert.deepEqual(
    profiles.map((profile) => profile.name),
    ["Personal", "Work account", "No unsafe avatar"]
  );
  assert.equal(profiles[0]?.email, "person@example.com");
  assert.equal(
    profiles[0]?.avatarDataUrl,
    `data:image/png;base64,${avatarBytes.toString("base64")}`
  );
  assert.equal(profiles[2]?.avatarDataUrl, undefined);
  assert.ok(
    profiles.every((profile) => !JSON.stringify(profile).includes(root))
  );
  assert.ok(
    profiles.every((profile) => !JSON.stringify(profile).includes("chrome://"))
  );
  assert.equal(new Set(profiles.map((profile) => profile.id)).size, 3);
});

test("rejects symlinked Chrome Profile avatar files", async (t) => {
  const root = await chromeRoot(t);
  const outsideAvatar = join(root, "outside-avatar.png");
  await writeFile(outsideAvatar, Buffer.from("89504e470d0a1a0a", "hex"));
  await createProfileDatabase(root, "Default", [], 24, "new");
  await symlink(
    outsideAvatar,
    join(root, "Default", "Google Profile Picture.png")
  );
  await writeLocalState(root, { Default: { name: "Default" } });

  const profiles = await discoverChromeCookieProfiles(dependencies(root));

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.avatarDataUrl, undefined);
});

test("rejects profile and Cookies DB symlinks and ignores profiles outside Local State", async (t) => {
  const root = await chromeRoot(t);
  const outside = await mkdtemp(join(tmpdir(), "tutti-chrome-outside-"));
  t.after(() => rm(outside, { force: true, recursive: true }));
  await mkdir(join(outside, "Network"), { recursive: true });
  await writeFile(join(outside, "Network", "Cookies"), "outside");
  await symlink(outside, join(root, "Profile 1"));
  await mkdir(join(root, "Profile 2", "Network"), { recursive: true });
  await symlink(
    join(outside, "Network", "Cookies"),
    join(root, "Profile 2", "Network", "Cookies")
  );
  await createProfileDatabase(root, "Default", [], 24, "new");
  await writeLocalState(root, {
    Default: { name: "Valid" },
    "Profile 1": { name: "Profile symlink" },
    "Profile 2": { name: "DB symlink" },
    "Profile 3": { name: "Missing" }
  });

  const profiles = await discoverChromeCookieProfiles(dependencies(root));
  assert.deepEqual(
    profiles.map((profile) => profile.name),
    ["Valid"]
  );
});

test("returns no profiles on unsupported platforms", async (t) => {
  const root = await chromeRoot(t);
  assert.deepEqual(
    await discoverChromeCookieProfiles({
      ...dependencies(root),
      platform: "win32"
    }),
    []
  );
});

test("decrypts the fixed Chrome macOS v10 and database v24 host-hash vector", () => {
  const encrypted = Buffer.from(
    "djEwbNhhwaPLEvm+RbwD+oYe1EIC5epfeoFbuRv8+JJObSlwi55MwQbvxajsVE9rZjRX",
    "base64"
  );
  assert.equal(
    decryptChromeV10CookieForTesting(
      encrypted,
      Buffer.from("test-safe-storage-secret"),
      ".example.com",
      24
    ),
    "session-value"
  );
});

test("prepares persistent and session cookies with Electron-compatible metadata and skips expired and CHIPS cookies", async (t) => {
  const root = await chromeRoot(t);
  const secret = Buffer.from("fixture-secret");
  await createProfileDatabase(
    root,
    "Default",
    [
      {
        encryptedValue: encryptCookie(
          "persistent-value",
          secret,
          ".example.com",
          24
        ),
        expiresUtc: FUTURE_CHROME_TIME,
        hasExpires: 1,
        hostKey: ".example.com",
        httpOnly: 1,
        name: "persistent",
        path: "/account",
        persistent: 1,
        sameSite: 2,
        secure: 1
      },
      {
        encryptedValue: encryptCookie(
          "session-value",
          secret,
          "host.example",
          24
        ),
        expiresUtc: "0",
        hostKey: "host.example",
        name: "session",
        sameSite: 1
      },
      {
        encryptedValue: encryptCookie("old", secret, ".expired.test", 24),
        expiresUtc: PAST_CHROME_TIME,
        hasExpires: 1,
        hostKey: ".expired.test",
        name: "expired",
        persistent: 1
      },
      {
        encryptedValue: encryptCookie("partitioned", secret, ".chips.test", 24),
        hostKey: ".chips.test",
        name: "chips",
        topFrameSiteKey: "https://top-frame.test"
      },
      {
        encryptedValue: encryptCookie(
          "partitioned2",
          secret,
          ".chips2.test",
          24
        ),
        hostKey: ".chips2.test",
        isPartitioned: 1,
        name: "chips2"
      },
      {
        encryptedValue: Buffer.from("v10damaged"),
        hostKey: ".damaged.test",
        name: "damaged"
      }
    ],
    24,
    "new"
  );
  await writeLocalState(root, { Default: { name: "Default" } });
  const [profile] = await discoverChromeCookieProfiles(dependencies(root));
  assert.ok(profile);

  const prepared = await prepareChromeCookies(profile.id, {
    ...dependencies(root),
    now: () => NOW_MS,
    readKeychainSecret: async () => Buffer.from(secret)
  });

  assert.equal(prepared.databaseVersion, 24);
  assert.equal(prepared.skipped, 4);
  assert.deepEqual(prepared.cookies, [
    {
      domain: ".example.com",
      expirationDate: Math.floor(NOW_MS / 1000) + 3_600,
      httpOnly: true,
      name: "persistent",
      path: "/account",
      sameSite: "strict",
      secure: true,
      url: "https://example.com/account",
      value: "persistent-value"
    },
    {
      httpOnly: false,
      name: "session",
      path: "/",
      sameSite: "lax",
      secure: false,
      url: "http://host.example/",
      value: "session-value"
    }
  ]);
});

test("does not access Keychain for databases containing only plaintext cookies", async (t) => {
  const root = await chromeRoot(t);
  await createProfileDatabase(
    root,
    "Default",
    [{ hostKey: "plain.example", name: "plain", value: "value" }],
    23,
    "new"
  );
  await writeLocalState(root, { Default: { name: "Default" } });
  const [profile] = await discoverChromeCookieProfiles(dependencies(root));
  assert.ok(profile);
  let keychainReads = 0;
  const result = await prepareChromeCookies(profile.id, {
    ...dependencies(root),
    readKeychainSecret: async () => {
      keychainReads += 1;
      return Buffer.from("unused");
    }
  });
  assert.equal(keychainReads, 0);
  assert.equal(result.cookies[0]?.value, "value");
});

test("fails closed when every encrypted cookie has a database v24 host integrity mismatch", async (t) => {
  const root = await chromeRoot(t);
  const secret = Buffer.from("fixture-secret");
  await createProfileDatabase(
    root,
    "Default",
    [
      {
        encryptedValue: encryptCookie("value", secret, ".wrong.test", 24),
        hostKey: ".actual.test",
        name: "cookie"
      }
    ],
    24,
    "new"
  );
  await writeLocalState(root, { Default: { name: "Default" } });
  const [profile] = await discoverChromeCookieProfiles(dependencies(root));
  assert.ok(profile);
  await assert.rejects(
    prepareChromeCookies(profile.id, {
      ...dependencies(root),
      readKeychainSecret: async () => Buffer.from(secret)
    }),
    hasCode("integrity_failed")
  );
});

test("fails closed for a systematically incompatible cipher", async (t) => {
  const root = await chromeRoot(t);
  await createProfileDatabase(
    root,
    "Default",
    [
      {
        encryptedValue: Buffer.from("v10not-a-ciphertext"),
        hostKey: ".example.test",
        name: "cookie"
      }
    ],
    23,
    "new"
  );
  await writeLocalState(root, { Default: { name: "Default" } });
  const [profile] = await discoverChromeCookieProfiles(dependencies(root));
  assert.ok(profile);
  await assert.rejects(
    prepareChromeCookies(profile.id, {
      ...dependencies(root),
      readKeychainSecret: async () => Buffer.from("wrong")
    }),
    hasCode("cipher_incompatible")
  );
});

test("propagates classified Keychain denial and timeout before producing cookies", async (t) => {
  const root = await chromeRoot(t);
  await createProfileDatabase(
    root,
    "Default",
    [
      {
        encryptedValue: Buffer.from("v10encrypted"),
        hostKey: ".example.test",
        name: "cookie"
      }
    ],
    24,
    "new"
  );
  await writeLocalState(root, { Default: { name: "Default" } });
  const [profile] = await discoverChromeCookieProfiles(dependencies(root));
  assert.ok(profile);
  for (const code of ["keychain_denied", "keychain_timeout"] as const) {
    await assert.rejects(
      prepareChromeCookies(profile.id, {
        ...dependencies(root),
        readKeychainSecret: async () => {
          throw new ChromeCookieImportError(code);
        }
      }),
      hasCode(code)
    );
  }
});

test("classifies /usr/bin/security denial, timeout, and unavailable failures without exposing output", () => {
  assert.equal(
    classifyChromeKeychainFailure(
      { killed: false },
      "security: User canceled the operation"
    ),
    "keychain_denied"
  );
  assert.equal(
    classifyChromeKeychainFailure({ killed: true, signal: "SIGTERM" }, ""),
    "keychain_timeout"
  );
  assert.equal(
    classifyChromeKeychainFailure(
      { code: 44 },
      "The specified item could not be found in the keychain"
    ),
    "keychain_failed"
  );
});

test("re-resolves opaque profile ids and rejects a removed or replaced profile", async (t) => {
  const root = await chromeRoot(t);
  await createProfileDatabase(root, "Default", [], 24, "new");
  await writeLocalState(root, { Default: { name: "Default" } });
  const [profile] = await discoverChromeCookieProfiles(dependencies(root));
  assert.ok(profile);
  await rm(join(root, "Default"), { force: true, recursive: true });
  await assert.rejects(
    prepareChromeCookies(profile.id, dependencies(root)),
    hasCode("profile_not_found")
  );
  await assert.rejects(
    prepareChromeCookies("../../arbitrary-path", dependencies(root)),
    hasCode("profile_not_found")
  );
});

test("SQLite backup includes committed WAL data and always removes its temporary snapshot", async (t) => {
  const directory = await testDirectory(t, "tutti-chrome-wal-");
  const source = join(directory, "Cookies");
  const database = new DatabaseSync(source);
  t.after(() => database.close());
  database.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE values_table (value TEXT); INSERT INTO values_table VALUES ('wal-row')"
  );
  assert.equal((await lstat(`${source}-wal`)).isFile(), true);
  let capturedSnapshot = "";
  const value = await withChromeCookieDatabaseSnapshot(
    source,
    async (snapshot) => {
      capturedSnapshot = snapshot;
      const copy = new DatabaseSync(snapshot, { readOnly: true });
      try {
        return (
          copy.prepare("SELECT value FROM values_table").get() as {
            value: string;
          }
        ).value;
      } finally {
        copy.close();
      }
    }
  );
  assert.equal(value, "wal-row");
  await assert.rejects(lstat(capturedSnapshot));
});

test("SQLite backup reads a consistent DELETE-journal database and cleans up after callback failures", async (t) => {
  const directory = await testDirectory(t, "tutti-chrome-journal-");
  const source = join(directory, "Cookies");
  const database = new DatabaseSync(source);
  database.exec(
    "PRAGMA journal_mode=DELETE; CREATE TABLE values_table (value TEXT); INSERT INTO values_table VALUES ('journal-row')"
  );
  database.exec(
    "BEGIN IMMEDIATE; UPDATE values_table SET value = 'uncommitted'"
  );
  assert.equal((await lstat(`${source}-journal`)).isFile(), true);
  let capturedSnapshot = "";
  await assert.rejects(
    withChromeCookieDatabaseSnapshot(source, async (snapshot) => {
      capturedSnapshot = snapshot;
      const copy = new DatabaseSync(snapshot, { readOnly: true });
      try {
        assert.equal(
          (
            copy.prepare("SELECT value FROM values_table").get() as {
              value: string;
            }
          ).value,
          "journal-row"
        );
      } finally {
        copy.close();
      }
      throw new Error("callback failed");
    }),
    hasCode("snapshot_failed")
  );
  database.exec("ROLLBACK");
  database.close();
  await assert.rejects(lstat(capturedSnapshot));
});

test("rejects missing required schema before requesting Keychain", async (t) => {
  const root = await chromeRoot(t);
  const databasePath = join(root, "Default", "Network", "Cookies");
  await mkdir(join(root, "Default", "Network"), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(
    "CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '24'); CREATE TABLE cookies (name TEXT)"
  );
  database.close();
  await writeLocalState(root, { Default: { name: "Default" } });
  const [profile] = await discoverChromeCookieProfiles(dependencies(root));
  assert.ok(profile);
  let keychainReads = 0;
  await assert.rejects(
    prepareChromeCookies(profile.id, {
      ...dependencies(root),
      readKeychainSecret: async () => {
        keychainReads += 1;
        return Buffer.from("secret");
      }
    }),
    hasCode("schema_unsupported")
  );
  assert.equal(keychainReads, 0);
});

function dependencies(root: string) {
  return { chromeUserDataRoot: root, platform: "darwin" as const };
}

async function chromeRoot(t: test.TestContext): Promise<string> {
  return testDirectory(t, "tutti-chrome-root-");
}

async function testDirectory(
  t: test.TestContext,
  prefix: string
): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

async function writeLocalState(
  root: string,
  infoCache: Record<string, Record<string, unknown>>
): Promise<void> {
  await writeFile(
    join(root, "Local State"),
    JSON.stringify({ profile: { info_cache: infoCache } })
  );
}

async function createProfileDatabase(
  root: string,
  profile: string,
  cookies: CookieFixture[],
  version: number,
  location: "new" | "old"
): Promise<string> {
  const directory =
    location === "new" ? join(root, profile, "Network") : join(root, profile);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "Cookies");
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE meta (key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
    INSERT INTO meta (key, value) VALUES ('version', '${version}');
    CREATE TABLE cookies (
      host_key TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      encrypted_value BLOB NOT NULL,
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL,
      is_secure INTEGER NOT NULL,
      is_httponly INTEGER NOT NULL,
      has_expires INTEGER NOT NULL,
      is_persistent INTEGER NOT NULL,
      samesite INTEGER NOT NULL,
      top_frame_site_key TEXT NOT NULL DEFAULT '',
      partition_key TEXT NOT NULL DEFAULT '',
      is_partitioned INTEGER NOT NULL DEFAULT 0
    )
  `);
  const insert = database.prepare(`INSERT INTO cookies (
    host_key, name, value, encrypted_value, path, expires_utc, is_secure,
    is_httponly, has_expires, is_persistent, samesite, top_frame_site_key,
    partition_key, is_partitioned
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const cookie of cookies) {
    insert.run(
      cookie.hostKey ?? ".example.test",
      cookie.name ?? "cookie",
      cookie.value ?? "",
      cookie.encryptedValue ?? Buffer.alloc(0),
      cookie.path ?? "/",
      cookie.expiresUtc ?? "0",
      cookie.secure ?? 0,
      cookie.httpOnly ?? 0,
      cookie.hasExpires ?? 0,
      cookie.persistent ?? 0,
      cookie.sameSite ?? -1,
      cookie.topFrameSiteKey ?? "",
      cookie.partitionKey ?? "",
      cookie.isPartitioned ?? 0
    );
  }
  database.close();
  return path;
}

function encryptCookie(
  value: string,
  secret: Buffer,
  hostKey: string,
  databaseVersion: number
): Buffer {
  const key = pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1");
  const valueBuffer = Buffer.from(value);
  const plaintext =
    databaseVersion >= 24
      ? Buffer.concat([
          createHash("sha256").update(hostKey).digest(),
          valueBuffer
        ])
      : valueBuffer;
  try {
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    return Buffer.concat([
      Buffer.from("v10"),
      cipher.update(plaintext),
      cipher.final()
    ]);
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ChromeCookieImportError && error.code === code;
}
