export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status = 0,
    public requestId: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
type RequestOptions = { signal?: AbortSignal };
type Fetch = typeof fetch;
/** One bootstrap in flight, bounded requests, and deliberately no automatic mutation replay. */
export function createApiClient(fetcher: Fetch = fetch, timeoutMs = 15000) {
  let token = "";
  let session: Promise<string> | null = null;
  async function getToken() {
    if (token) return token;
    if (!session)
      session = (async () => {
        const response = await fetcher("/api/session", {
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store",
        });
        if (!response.ok)
          throw new ApiError(
            "Cannot establish a local session.",
            "SESSION_UNAVAILABLE",
            response.status,
            response.headers.get("x-request-id"),
          );
        const data: unknown = await response.json();
        if (
          !data ||
          typeof data !== "object" ||
          !("token" in data) ||
          typeof data.token !== "string" ||
          !data.token
        )
          throw new ApiError(
            "The local server returned an invalid session.",
            "INVALID_SESSION",
          );
        token = data.token;
        return token;
      })().finally(() => {
        session = null;
      });
    return session;
  }
  return async function request<T>(
    url: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    if (!url.startsWith("/") || url.startsWith("//"))
      throw new ApiError("Only local API paths are allowed.", "INVALID_PATH");
    try {
      const authorization = await getToken();
      const signals = [
        AbortSignal.timeout(timeoutMs),
        ...(options.signal ? [options.signal] : []),
      ];
      const response = await fetcher("/api" + url, {
        method: body === undefined ? "GET" : "POST",
        cache: "no-store",
        headers: {
          authorization: "Bearer " + authorization,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any(signals),
      });
      const requestId = response.headers.get("x-request-id");
      const contentType = response.headers.get("content-type") ?? "";
      let data: unknown;
      try {
        data = contentType.includes("application/json")
          ? await response.json()
          : contentType.includes("text/csv") && response.ok
            ? await response.text()
            : null;
      } catch {
        throw new ApiError(
          "The local server returned an unreadable response.",
          "INVALID_RESPONSE",
          response.status,
          requestId,
        );
      }
      if (!response.ok) {
        if (response.status === 401) token = "";
        const error =
          data && typeof data === "object"
            ? (data as Record<string, unknown>)
            : {};
        throw new ApiError(
          typeof error.message === "string"
            ? error.message
            : "The local request failed.",
          typeof error.error === "string" ? error.error : "HTTP_ERROR",
          response.status,
          requestId,
        );
      }
      if (data === null)
        throw new ApiError(
          "Unexpected server response. Check that the local API is running.",
          "INVALID_RESPONSE",
          response.status,
          requestId,
        );
      return data as T;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (error instanceof ApiError) throw error;
      const timeout = error instanceof Error && error.name === "TimeoutError";
      const note =
        body === undefined
          ? ""
          : " The action may have executed; inspect the ledger before retrying.";
      throw new ApiError(
        (timeout
          ? "The local request timed out."
          : "Cannot reach the local server.") + note,
        timeout ? "TIMEOUT" : "NETWORK_ERROR",
      );
    }
  };
}
