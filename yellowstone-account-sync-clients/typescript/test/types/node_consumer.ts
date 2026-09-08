import {
  AccountSyncTransports,
  Connection
} from "@triton-one/triton-sdk";
import type { PublicApiChecks } from "./public_api";

const connection = new Connection("https://example.com/token", {
  accountSync: {
    transport: AccountSyncTransports.GRPC,
    grpc: {
      flowControlWindowBytes: 8 * 1024 * 1024
    }
  }
});

void connection;
export type NodeChecks = PublicApiChecks;
