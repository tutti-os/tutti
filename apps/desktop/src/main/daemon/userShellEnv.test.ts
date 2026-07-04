import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAllowedUserShellEnv,
  resolveUserShellEnvInvocation,
  userShellEnvTimeoutMs
} from "./userShellEnv.ts";

test("user shell env timeout allows slow interactive startup files", () => {
  assert.equal(userShellEnvTimeoutMs, 10_000);
});

test("user shell env invocation uses interactive login shell for zsh", () => {
  assert.deepEqual(resolveUserShellEnvInvocation("darwin", "/bin/zsh"), {
    args: ["-lic", "printf '%s\\0' __TUTTI_USER_SHELL_ENV_START__; env -0"],
    shell: "/bin/zsh"
  });
});

test("user shell env invocation is disabled on Windows", () => {
  assert.equal(resolveUserShellEnvInvocation("win32", "cmd.exe"), null);
});

test("parseAllowedUserShellEnv keeps only runtime environment keys", () => {
  const output = [
    "profile noise",
    "__TUTTI_USER_SHELL_ENV_START__\0",
    "PATH=/custom/bin:/usr/bin\0",
    "FNM_DIR=/Users/test/.fnm\0",
    "LANG=zh_CN.UTF-8\0",
    "LC_CTYPE=UTF-8\0",
    "MISE_DATA_DIR=/Users/test/.local/share/mise\0",
    "SECRET_TOKEN=hidden\0"
  ].join("");

  assert.deepEqual(parseAllowedUserShellEnv(output), {
    FNM_DIR: "/Users/test/.fnm",
    LANG: "zh_CN.UTF-8",
    LC_CTYPE: "UTF-8",
    MISE_DATA_DIR: "/Users/test/.local/share/mise",
    PATH: "/custom/bin:/usr/bin"
  });
});

test("parseAllowedUserShellEnv forwards proxy variables in both cases", () => {
  const output = [
    "__TUTTI_USER_SHELL_ENV_START__\0",
    "HTTPS_PROXY=http://127.0.0.1:7890\0",
    "https_proxy=http://127.0.0.1:7890\0",
    "http_proxy=http://127.0.0.1:7890\0",
    "ALL_PROXY=socks5://127.0.0.1:7891\0",
    "no_proxy=localhost,.internal\0",
    "PROXY_TOKEN=hidden\0"
  ].join("");

  assert.deepEqual(parseAllowedUserShellEnv(output), {
    ALL_PROXY: "socks5://127.0.0.1:7891",
    HTTPS_PROXY: "http://127.0.0.1:7890",
    http_proxy: "http://127.0.0.1:7890",
    https_proxy: "http://127.0.0.1:7890",
    no_proxy: "localhost,.internal"
  });
});
