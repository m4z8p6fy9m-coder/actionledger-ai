import { describe, it, expect, vi } from "vitest";
import { createApiClient } from "../apps/web/src/lib/api-client";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-test-123",
    },
  });
describe("local dashboard transport", () => {
  it("coalesces concurrent session bootstrap without coalescing independent reads", async () => {
    let release!: (response: Response) => void;
    const session = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        url === "/api/session" ? session : json({ ok: true }),
      );
    const request = createApiClient(fetcher);
    const reads = [request("/state"), request("/actions"), request("/audit")];
    release(json({ token: "local-session-token" }));
    await Promise.all(reads);
    expect(
      fetcher.mock.calls.filter(([url]) => url === "/api/session"),
    ).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("never automatically repeats a mutation after an interrupted connection", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "token" }))
      .mockRejectedValueOnce(new TypeError("Connection reset"));
    const request = createApiClient(fetcher);
    await expect(request("/actions/id/execute", {})).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: expect.stringContaining("may have executed"),
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("preserves structured errors and request correlation without exposing credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "private-token" }))
      .mockResolvedValueOnce(
        json({ error: "UNSAFE_RETRY", message: "Replay blocked" }, 409),
      );
    await expect(
      createApiClient(fetcher)("/actions/id/recover", {}),
    ).rejects.toMatchObject({
      code: "UNSAFE_RETRY",
      status: 409,
      requestId: "request-test-123",
      message: "Replay blocked",
    });
  });
  it("refreshes an expired session only on a subsequent caller request", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "old" }))
      .mockResolvedValueOnce(json({ error: "UNAUTHORIZED" }, 401))
      .mockResolvedValueOnce(json({ token: "new" }))
      .mockResolvedValueOnce(json({ ok: true }));
    const request = createApiClient(fetcher);
    await expect(request("/actions/id/execute", {})).rejects.toMatchObject({
      status: 401,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(request("/state")).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("handles timeout ambiguity without automatic execution replay", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "token" }))
      .mockRejectedValueOnce(new DOMException("Timeout", "TimeoutError"));
    await expect(
      createApiClient(fetcher)("/actions/id/execute", {}),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      message: expect.stringContaining("inspect the ledger"),
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects malformed proxy responses and invalid local sessions", async () => {
    const badSession = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: 7 }));
    await expect(createApiClient(badSession)("/state")).rejects.toMatchObject({
      code: "INVALID_SESSION",
    });
    const html = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "token" }))
      .mockResolvedValueOnce(
        new Response("<html>proxy error</html>", {
          headers: { "content-type": "text/html" },
        }),
      );
    await expect(createApiClient(html)("/state")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
  it("supports safe CSV responses and attaches bounded abort signals", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "token" }))
      .mockResolvedValueOnce(
        new Response("id,key\r\n", { headers: { "content-type": "text/csv" } }),
      );
    expect(await createApiClient(fetcher)("/actions/export")).toBe(
      "id,key\r\n",
    );
    expect(fetcher.mock.calls[1][1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it("preserves deliberate read cancellation and refuses foreign API paths", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "token" }))
      .mockImplementation(async (_url, options) => {
        options?.signal?.throwIfAborted();
        return json({ ok: true });
      });
    await expect(
      createApiClient(fetcher)("/state", undefined, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      createApiClient(fetcher)("//external.example"),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
  });
});

it("preserves the literal search ALL while omitting only the all-status sentinel", async () => {
  const { actionQuery } = await import("../apps/web/src/hooks/useActionPage");
  const params = new URLSearchParams(
    actionQuery({ q: "ALL", status: "ALL", offset: 0, limit: 25 }),
  );
  expect(params.get("q")).toBe("ALL");
  expect(params.has("status")).toBe(false);
  expect(params.get("offset")).toBe("0");
});
