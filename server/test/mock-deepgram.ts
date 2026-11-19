import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Captured {
  auth?: string;
  contentType?: string;
  query: URLSearchParams;
  bodyHead: Buffer;
  bodySize: number;
}

/** Local stand-in for api.deepgram.com/v1/listen. */
export async function startMockDeepgram() {
  const state = {
    mode: "ok" as "ok" | "401" | "402" | "400" | "flaky" | "empty",
    calls: 0,
    last: null as Captured | null,
  };
  const words = [
    ["hi", "Hi,", 0.2, 0.45], ["i'm", "I'm", 0.5, 0.7], ["sokchea", "Sokchea.", 0.75, 1.2],
    ["welcome", "Welcome", 1.6, 1.95], ["to", "to", 2.0, 2.1], ["my", "my", 2.15, 2.3], ["studio", "studio.", 2.35, 2.9],
  ].map(([word, punctuated_word, start, end]) => ({ word, punctuated_word, start, end, confidence: 0.97 }));

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      state.calls++;
      const body = Buffer.concat(chunks);
      const url = new URL(req.url!, "http://x");
      state.last = { auth: req.headers.authorization, contentType: req.headers["content-type"], query: url.searchParams, bodyHead: body.subarray(0, 4), bodySize: body.length };
      const send = (status: number, json: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(json));
      if (url.pathname !== "/v1/listen" || req.method !== "POST") return send(404, { err_msg: "not found" });
      if (state.mode === "401") return send(401, { err_code: "INVALID_AUTH", err_msg: "Invalid credentials." });
      if (state.mode === "402") return send(402, { err_code: "ASR_PAYMENT_REQUIRED", err_msg: "Project does not have enough credits" });
      if (state.mode === "400") return send(400, { err_code: "Bad Request", err_msg: "Bad Request: failed to process audio: corrupt or unsupported data" });
      if (state.mode === "flaky" && state.calls === 1) return send(503, { err_msg: "overloaded" });
      send(200, {
        metadata: { request_id: "mock-req-1", duration: 4 },
        results: { channels: [{ detected_language: "en", alternatives: [{ transcript: "", words: state.mode === "empty" ? [] : words }] }] },
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}
