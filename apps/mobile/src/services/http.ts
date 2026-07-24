export class HTTPError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HTTPError";
    this.status = status;
  }
}

export async function readJSON<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as T | null;
  if (!response.ok || payload === null) {
    throw new HTTPError(
      `Request failed with status ${response.status}`,
      response.status
    );
  }
  return payload;
}

export function accountCookie(sessionID: string): string {
  const value = sessionID.trim();
  if (!value) {
    throw new Error("account session is missing");
  }
  return `session_id=${value}`;
}
