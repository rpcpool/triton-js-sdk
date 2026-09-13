import { describe, expect, it } from "vitest";
import { normalizeGrpcEndpoint } from "../src/transport/grpc";

describe("normalizeGrpcEndpoint", () => {
  it("uses host token path as grpc x-token metadata", () => {
    const normalized = normalizeGrpcEndpoint(
      "https://api.example.com/yourToken",
    );

    expect(normalized.target).toBe("api.example.com");
    expect(normalized.metadata.get("x-token")).toEqual(["yourToken"]);
  });

  it("does not set token metadata when endpoint has no path", () => {
    const normalized = normalizeGrpcEndpoint("http://127.0.0.1:11000");
    expect(normalized.target).toBe("127.0.0.1:11000");
    expect(normalized.metadata.get("x-token")).toEqual([]);
  });

  it("rejects grpc endpoints with unsupported protocols", () => {
    expect(() => normalizeGrpcEndpoint("ws://example.com/token")).toThrow(
      /invalid grpc endpoint protocol/,
    );
  });

  it("rejects grpc endpoints with more than one path segment", () => {
    expect(() => normalizeGrpcEndpoint("https://example.com/token/extra")).toThrow(
      /invalid grpc endpoint path/,
    );
  });

  it("rejects grpc endpoints that include the generated method path", () => {
    expect(() =>
      normalizeGrpcEndpoint(
        "https://example.com/YellowstoneAccountSyncGrpcService/Subscribe",
      )
    ).toThrow(/invalid grpc endpoint path/);
  });
});
