import { Connection as Web3Connection } from "@solana/web3.js";
import { expect, it, vi } from "vitest";
import {
  Connection as NodeConnection,
  AccountSyncConnection as NodeAccountSyncConnection
} from "../src/connection/node_connection";
import {
  Connection as BrowserConnection,
  AccountSyncConnection as BrowserAccountSyncConnection
} from "../src/connection/browser_connection";

vi.mock("../src/core/account_sync_core", () => ({
  AccountSyncCore: class {}
}));

it("selects the connection type and account methods based on accountSync", () => {
  const methods = [
    "getAccountInfo",
    "getAccountInfoAndContext",
    "getParsedAccountInfo",
    "getMultipleAccountsInfo",
    "getMultipleAccountsInfoAndContext",
    "getMultipleParsedAccounts"
  ] as const;

  for (const [Connection, AccountSyncConnection] of [
    [NodeConnection, NodeAccountSyncConnection],
    [BrowserConnection, BrowserAccountSyncConnection]
  ] as const) {
    const native = new Connection("https://example.com");
    const enabled = new Connection("https://example.com", { accountSync: {} });

    expect(Object.getPrototypeOf(native)).toBe(Web3Connection.prototype);
    expect(Object.getPrototypeOf(enabled)).toBe(AccountSyncConnection.prototype);
    for (const method of methods) {
      expect(native[method]).toBe(Web3Connection.prototype[method]);
      expect(enabled[method]).toBe(AccountSyncConnection.prototype[method]);
      expect(enabled[method]).not.toBe(Web3Connection.prototype[method]);
    }
  }
});
