import { accountAppID, accountBaseURL } from "../config";
import type { AccountSession } from "../native/mobileNative";
import { accountCookie, HTTPError, readJSON } from "./http";

interface AccountEnvelope<T> {
  code?: number;
  data?: T;
  errmsg?: string;
  message?: string;
}

interface UserInfo {
  avatar?: string;
  email?: string;
  emailAddress?: string;
  email_address?: string;
  name?: string;
  userId?: string;
  user_id?: string;
}

export async function sendEmailCode(email: string): Promise<void> {
  const payload = await accountRequest<{ success?: boolean }>(
    "auth/v1/send_auth_code",
    {
      app_id: accountAppID,
      email: email.trim()
    }
  );
  if (payload.success !== true) {
    throw new Error("verification code request was not accepted");
  }
}

export async function verifyEmailCode(
  email: string,
  code: string
): Promise<AccountSession> {
  const verified = await accountRequest<{
    sessionId?: string;
    session_id?: string;
  }>("auth/v1/verify_auth_code_for_session", {
    app_id: accountAppID,
    code: code.trim(),
    email: email.trim()
  });
  const sessionId = String(
    verified.sessionId ?? verified.session_id ?? ""
  ).trim();
  if (!sessionId) {
    throw new Error("account session is missing");
  }
  const user = await accountRequest<UserInfo>(
    "user/v1/user_info",
    {},
    sessionId
  );
  const userId = String(user.userId ?? user.user_id ?? "").trim();
  if (!userId) {
    throw new Error("account user is missing");
  }
  return {
    email: String(
      user.email ?? user.emailAddress ?? user.email_address ?? email
    ).trim(),
    name: String(user.name ?? "").trim(),
    sessionId,
    userId
  };
}

async function accountRequest<T>(
  path: string,
  body: Record<string, string>,
  sessionId?: string
): Promise<T> {
  const response = await fetch(`${accountBaseURL}/${path}`, {
    body: JSON.stringify(body),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(sessionId ? { Cookie: accountCookie(sessionId) } : {})
    },
    method: "POST"
  });
  const envelope = await readJSON<AccountEnvelope<T>>(response);
  if (envelope.code !== 0 || envelope.data === undefined) {
    throw new HTTPError(
      envelope.errmsg ?? envelope.message ?? "Account request failed",
      response.status
    );
  }
  return envelope.data;
}
