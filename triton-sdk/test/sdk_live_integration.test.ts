import { Buffer } from "buffer";
import dotenv from "dotenv";
import { describe, expect, it, vi } from "vitest";
import {
  AccountSyncTransports,
  Connection,
  PublicKey,
  type AccountInfo,
  type NodeSubscriptionTransport
} from "../src/node";

dotenv.config({ quiet: true });

const DEFAULT_STREAM_ACCOUNT =
  "ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989";
const RPC_MARKER_DATA = Buffer.from("rpc-marker-only");
const RPC_MARKER_LAMPORTS = 987_654_321;
const LIVE_TIMEOUT_MS = readPositiveInteger("TEST_LIVE_TIMEOUT_MS", 60_000);
const endpoint = readTestEndpoint();
const streamAccount = new PublicKey(
  process.env.TEST_STREAM_ACCOUNT?.trim() || DEFAULT_STREAM_ACCOUNT
);

describe.each([AccountSyncTransports.GRPC, AccountSyncTransports.WS] as const)(
  "public SDK buffer transition over %s",
  (transport: NodeSubscriptionTransport) => {
    it(
      "serves the first read from RPC and a later read from the stream",
      async () => {
        let successfulRpcResponses = 0;
        const fetchMock = vi.fn<typeof fetch>(async () => {
          if (successfulRpcResponses > 0) {
            throw new Error("RPC is disabled after the initial account snapshot");
          }
          successfulRpcResponses += 1;
          return makeRpcMarkerResponse();
        });
        vi.stubGlobal("fetch", fetchMock);

        const connection = new Connection(endpoint, {
          commitment: "confirmed",
          accountSync: {
            transport,
            initialAccounts: [],
            autoSubscribeOnMiss: false,
            missTimeoutMs: 1_000,
            rpcPollIntervalMs: LIVE_TIMEOUT_MS,
            closeTimeoutMs: 5_000
          }
        });

        try {
          const initial = await connection.getAccountInfo(streamAccount);
          expect(initial?.lamports).toBe(RPC_MARKER_LAMPORTS);
          expect(initial?.data).toEqual(RPC_MARKER_DATA);
          expect(successfulRpcResponses).toBe(1);

          await connection.addAccounts([streamAccount]);
          const streamed = await waitForStreamedValue(connection, streamAccount);

          expect(streamed.data).not.toEqual(RPC_MARKER_DATA);
          expect(successfulRpcResponses).toBe(1);
          expect(fetchMock).toHaveBeenCalled();
        } finally {
          await connection.close();
          vi.unstubAllGlobals();
        }
      },
      LIVE_TIMEOUT_MS + 10_000
    );
  }
);

async function waitForStreamedValue(
  connection: Connection,
  account: PublicKey
): Promise<AccountInfo<Buffer>> {
  const deadline = Date.now() + LIVE_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const value = await connection.getAccountInfo(account);
      if (value && !value.data.equals(RPC_MARKER_DATA)) {
        return value;
      }
    } catch (error: unknown) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `stream did not replace the RPC marker for ${account.toBase58()}`,
    { cause: lastError }
  );
}

function makeRpcMarkerResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: {
        context: { slot: 0 },
        value: [
          {
            lamports: RPC_MARKER_LAMPORTS,
            owner: PublicKey.default.toBase58(),
            executable: false,
            rentEpoch: 0,
            data: [RPC_MARKER_DATA.toString("base64"), "base64"]
          }
        ]
      }
    })
  } as Response;
}

function readTestEndpoint(): string {
  const rawEndpoint = process.env.TEST_ENDPOINT?.trim();
  if (!rawEndpoint) {
    throw new Error("TEST_ENDPOINT is required for live tests");
  }

  const isLocalEndpoint =
    rawEndpoint.startsWith("localhost") ||
    rawEndpoint.startsWith("127.0.0.1") ||
    rawEndpoint.startsWith("[::1]") ||
    rawEndpoint.startsWith("::1") ||
    rawEndpoint.startsWith("0.0.0.0");
  const normalizedEndpoint = rawEndpoint.includes("://")
    ? rawEndpoint
    : isLocalEndpoint
      ? `http://${rawEndpoint}`
      : `https://${rawEndpoint}`;
  const url = new URL(normalizedEndpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("TEST_ENDPOINT must use http or https");
  }

  const token = process.env.TEST_TOKEN?.trim().replace(/^\/+|\/+$/g, "");
  if (token) {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.at(-1) !== token) {
      segments.push(token);
    }
    url.pathname = `/${segments.join("/")}`;
  }

  return url.toString();
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
