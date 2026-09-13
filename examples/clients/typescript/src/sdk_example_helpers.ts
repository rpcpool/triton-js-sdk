import { AccountSyncReadTimeoutError } from "@triton-one/triton-sdk";

export const ACCOUNT_SYNC_LIMITS = {
  autoSubscribeOnMiss: true,
  missTimeoutMs: 5_000,
  connectTimeoutMs: 10_000,
  closeTimeoutMs: 5_000,
  dynamicSubscriptionTtlMs: 60_000,
} as const;

export const GRPC_CHANNEL_OPTIONS = {
  flowControlWindowBytes: 16 * 1024 * 1024,
  maxReceiveMessageLengthBytes: 16 * 1024 * 1024,
  keepAliveIntervalMs: 30_000,
  keepAliveTimeoutMs: 10_000,
  keepAlivePermitWithoutCalls: true,
} as const;

export function endpointForLog(endpoint: string): string {
  const normalized = endpoint.includes("://") ? endpoint : `http://${endpoint}`;
  const url = new URL(normalized);
  return url.origin;
}

export function reportExampleError(error: unknown): void {
  if (error instanceof AccountSyncReadTimeoutError) {
    console.error(
      `read timed out: account=${error.accountId} commitment=${error.commitment} timeoutMs=${error.timeoutMs} minContextSlot=${error.minContextSlot ?? "none"}`,
    );
  } else {
    console.error(error);
  }

  process.exitCode = 1;
}
