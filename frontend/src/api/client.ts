import { useAuthStore } from "@/stores/auth";

const BASE = "/api";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const auth = useAuthStore();
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (auth.token) headers.set("authorization", `Bearer ${auth.token}`);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),

  /**
   * POST that returns an SSE stream. Caller receives parsed events one at a time.
   */
  async *stream(
    path: string,
    body: unknown,
  ): AsyncGenerator<{ event: string; data: unknown }, void, void> {
    const auth = useAuthStore();
    const headers = new Headers({
      "content-type": "application/json",
      accept: "text/event-stream",
    });
    if (auth.token) headers.set("authorization", `Bearer ${auth.token}`);
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) throw new Error(await res.text());

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf("\n\n");
      while (sep >= 0) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        sep = buf.indexOf("\n\n");
        let event = "message";
        let data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (data) {
          try {
            yield { event, data: JSON.parse(data) };
          } catch {
            yield { event, data };
          }
        }
      }
    }
  },
};
