import { describe, expect, it } from "vitest";
import { deriveWebSocketEndpoint } from "../src/connection/utils";
import { normalizeWsSubscriptionEndpoint } from "../src/transport/common";

describe("deriveWebSocketEndpoint", () => {
  it("maps http to ws", () => {
    expect(deriveWebSocketEndpoint("http://127.0.0.1:12000")).toContain(
      "ws://",
    );
  });

  it("maps https to wss", () => {
    expect(deriveWebSocketEndpoint("https://example.com")).toContain("wss://");
  });

  it("preserves rpc endpoint token path when mapping to websocket", () => {
    expect(deriveWebSocketEndpoint("https://example.com/yourToken")).toBe(
      "wss://example.com/yourToken",
    );
  });
});

describe("normalizeWsSubscriptionEndpoint", () => {
  it("inserts YellowstoneAccountSyncService/ws after token path segment", () => {
    const endpoint = normalizeWsSubscriptionEndpoint(
      "ws://api.example.com/yourToken",
    );
    expect(endpoint).toBe(
      "ws://api.example.com/yourToken/YellowstoneAccountSyncService/ws",
    );
  });

  it("keeps endpoint unchanged when token-first service path is already present", () => {
    const endpoint = normalizeWsSubscriptionEndpoint(
      "wss://example.com/yourToken/YellowstoneAccountSyncService/ws",
    );
    expect(endpoint).toBe(
      "wss://example.com/yourToken/YellowstoneAccountSyncService/ws",
    );
  });

  it("normalizes a derived tokenized rpc endpoint to the websocket service path", () => {
    const endpoint = normalizeWsSubscriptionEndpoint(
      deriveWebSocketEndpoint("https://example.com/yourToken"),
    );
    expect(endpoint).toBe(
      "wss://example.com/yourToken/YellowstoneAccountSyncService/ws",
    );
  });
});
