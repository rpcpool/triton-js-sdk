import "dotenv/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Connection as Web3Connection, PublicKey,
  type GetAccountInfoConfig, type RpcResponseAndContext
} from "@solana/web3.js";
import { AccountSyncConnection, AccountSyncTransports, Connection } from "../src/node";

const { RPC_URL, ACCOUNT_SYNC_URL } = process.env;
if (!RPC_URL || !ACCOUNT_SYNC_URL) {
  throw new Error("Set RPC_URL and ACCOUNT_SYNC_URL to run these tests");
}
const account = new PublicKey("ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989");
const reference = new Web3Connection(RPC_URL, {
  commitment: "confirmed", disableRetryOnRateLimit: true
});
let sdk: AccountSyncConnection;

beforeEach(() => {
  sdk = new Connection(RPC_URL, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    accountSync: {
      subscriptionEndpoint: ACCOUNT_SYNC_URL,
      transport: ACCOUNT_SYNC_URL.startsWith("ws") ? AccountSyncTransports.WS : AccountSyncTransports.GRPC,
      autoSubscribeOnMiss: false,
      missTimeoutMs: 3_000,
      connectTimeoutMs: 3_000,
      closeTimeoutMs: 1_000
    }
  });
});

afterEach(async () => { await sdk?.close(); });

const reads = [
  { name: "getAccountInfo", context: false,
    call: (c: Web3Connection, options?: GetAccountInfoConfig) => c.getAccountInfo(account, options) },
  { name: "getAccountInfoAndContext", context: true,
    call: (c: Web3Connection, options?: GetAccountInfoConfig) => c.getAccountInfoAndContext(account, options) },
  { name: "getMultipleAccountsInfo", context: false,
    call: (c: Web3Connection, options?: GetAccountInfoConfig) => c.getMultipleAccountsInfo([account], options) },
  { name: "getMultipleAccountsInfoAndContext", context: true,
    call: (c: Web3Connection, options?: GetAccountInfoConfig) => c.getMultipleAccountsInfoAndContext([account], options) },
  { name: "getParsedAccountInfo", context: true,
    call: (c: Web3Connection, options?: GetAccountInfoConfig) => c.getParsedAccountInfo(account, options) },
  { name: "getMultipleParsedAccounts", context: true,
    call: (c: Web3Connection, options?: GetAccountInfoConfig) => c.getMultipleParsedAccounts([account], options) }
];

describe.each(reads)("$name", ({ call, context }) => {
  it("returns the same account data as web3.js", async () => {
    const [actual, expected] = await Promise.all([call(sdk), call(reference)]);
    if (context) {
      const response = actual as RpcResponseAndContext<unknown>;
      expect(response.context.slot).toEqual(expect.any(Number));
      expect(response.value).toStrictEqual((expected as RpcResponseAndContext<unknown>).value);
    } else {
      expect(actual).toStrictEqual(expected);
    }
  });

  it("rejects a negative minContextSlot", async () => {
    await expect(call(sdk, { minContextSlot: -1 })).rejects.toThrow("non-negative safe integer");
  });
});

describe("subscription methods", () => {
  it.each(["addAccounts", "removeAccounts", "setAccounts"] as const)(
    "%s accepts the account and subsequent reads match web3.js",
    async (method) => {
      await sdk.addAccounts([account]);
      await expect(sdk[method]([account])).resolves.toBeUndefined();
      const [actual, expected] = await Promise.all([
        sdk.getAccountInfo(account), reference.getAccountInfo(account)
      ]);
      expect(expected).not.toBeNull();
      expect(actual).toStrictEqual(expected);
    }
  );

  it.each(["addAccounts", "removeAccounts", "setAccounts"] as const)(
    "%s rejects an invalid address",
    async (method) => {
      await expect(sdk[method](["invalid address"])).rejects.toThrow("Non-base58 character");
    }
  );
});

it("close is repeatable and rejects later reads and subscription changes", async () => {
  await sdk.addAccounts([account]);
  await sdk.close();
  await expect(sdk.close()).resolves.toBeUndefined();
  await expect(sdk.getAccountInfo(account)).rejects.toThrow("closed");
  for (const method of ["addAccounts", "removeAccounts", "setAccounts"] as const) {
    await expect(sdk[method]([account])).rejects.toThrow("closed");
  }
});
