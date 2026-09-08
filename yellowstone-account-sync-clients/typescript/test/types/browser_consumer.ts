import {
  AccountSyncTransports,
  Connection
} from "@triton-one/triton-sdk";
import type { PublicApiChecks } from "./public_api";

const connection = new Connection("https://example.com/token", {
  accountSync: {
    transport: AccountSyncTransports.WS
  }
});

void connection;
export type BrowserChecks = PublicApiChecks;
