import assert from "node:assert/strict";
import test from "node:test";
import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  browserNodeI18nResources,
  createBrowserNodeI18nRuntime
} from "../i18n/browserNodeI18n.ts";
import type {
  BrowserNodeChromeProfile,
  BrowserNodeChromeProfileId,
  BrowserNodeCookieImportResult
} from "../core/types.ts";
import {
  browserNodeCookieImportFeedback,
  chromeProfileAvatarDataUrl,
  initialChromeProfileSelection,
  isChromeCookieImportEligible,
  shouldShowChromeImportPrompt
} from "./chromeCookieImportUiModel.ts";

const profileId = (value: string): BrowserNodeChromeProfileId =>
  value as BrowserNodeChromeProfileId;
const profiles: BrowserNodeChromeProfile[] = [
  { id: profileId("one"), name: "One" },
  { id: profileId("two"), name: "Two" }
];
const feature = { i18n: createBrowserNodeI18nRuntime(undefined) };

test("Chinese Cookie import failure copy does not end with a Chinese full stop", () => {
  const i18n = createBrowserNodeI18nRuntime(
    createI18nRuntime({
      dictionaries: [browserNodeI18nResources["zh-CN"]]
    })
  );
  const message = i18n.t("settings.importFailed");

  assert.equal(message, "Cookie 导入失败");
  assert.equal(message.endsWith("。"), false);
});

test("Profile selection defaults only when exactly one Profile exists", () => {
  assert.equal(initialChromeProfileSelection([]), null);
  assert.equal(initialChromeProfileSelection(profiles), null);
  assert.equal(initialChromeProfileSelection([profiles[0]!]), profiles[0]!.id);
});

test("Chrome import eligibility includes only ordinary persistent Browser Sessions", () => {
  assert.equal(
    isChromeCookieImportEligible({
      sessionMode: "shared",
      sessionPartition: null
    }),
    true
  );
  assert.equal(
    isChromeCookieImportEligible({
      sessionMode: "profile",
      sessionPartition: null
    }),
    true
  );
  assert.equal(
    isChromeCookieImportEligible({
      sessionMode: "incognito",
      sessionPartition: null
    }),
    false
  );
  assert.equal(
    isChromeCookieImportEligible({
      sessionMode: "shared",
      sessionPartition: "persist:tutti-app:workspace:example"
    }),
    false
  );
});

test("Profile avatar rendering accepts only renderer-safe image data URLs", () => {
  const avatarDataUrl = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(
    chromeProfileAvatarDataUrl({
      avatarDataUrl,
      id: profileId("avatar"),
      name: "Avatar"
    }),
    avatarDataUrl
  );
  assert.equal(
    chromeProfileAvatarDataUrl({
      avatarDataUrl: "file:///Users/secret/avatar.png",
      id: profileId("unsafe"),
      name: "Unsafe"
    }),
    null
  );
  assert.equal(chromeProfileAvatarDataUrl(profiles[0]!), null);
});

test("Chrome prompt visibility requires an available non-empty discovery", () => {
  assert.equal(
    shouldShowChromeImportPrompt({
      dismissed: false,
      hasPromptAdapter: true,
      state: { profiles, status: "available" }
    }),
    true
  );
  for (const input of [
    {
      dismissed: true,
      hasPromptAdapter: true,
      state: { profiles, status: "available" as const }
    },
    {
      dismissed: false,
      hasPromptAdapter: false,
      state: { profiles, status: "available" as const }
    },
    {
      dismissed: false,
      hasPromptAdapter: true,
      state: { profiles: [], status: "available" as const }
    },
    {
      dismissed: false,
      hasPromptAdapter: true,
      state: { reason: "no-profiles" as const, status: "unavailable" as const }
    }
  ]) {
    assert.equal(shouldShowChromeImportPrompt(input), false);
  }
});

test("Cookie import feedback distinguishes canceled, failed, zero, partial, and success", () => {
  const cases: Array<{
    result: BrowserNodeCookieImportResult;
    tone: "error" | "success" | "warning" | null;
  }> = [
    {
      result: {
        canceled: true,
        failed: 0,
        imported: 0,
        partial: false,
        skipped: 0,
        status: "canceled"
      },
      tone: null
    },
    {
      result: {
        canceled: false,
        failed: 0,
        failureCode: "snapshot_failed",
        failureStage: "snapshot",
        imported: 0,
        partial: false,
        skipped: 0,
        status: "failed"
      },
      tone: "error"
    },
    {
      result: {
        canceled: false,
        failed: 0,
        imported: 0,
        partial: false,
        skipped: 2,
        status: "completed"
      },
      tone: "warning"
    },
    {
      result: {
        canceled: false,
        failed: 1,
        imported: 2,
        partial: true,
        skipped: 3,
        status: "completed"
      },
      tone: "warning"
    },
    {
      result: {
        canceled: false,
        failed: 0,
        imported: 2,
        partial: false,
        skipped: 0,
        status: "completed"
      },
      tone: "success"
    }
  ];

  for (const { result, tone } of cases) {
    assert.equal(
      browserNodeCookieImportFeedback(feature, result)?.tone ?? null,
      tone
    );
  }
});
