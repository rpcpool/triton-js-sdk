import type { AccountSyncCommitment } from "./types";

export interface AccountSyncReadTimeoutErrorOptions {
  accountId: string;
  commitment: AccountSyncCommitment;
  timeoutMs: number;
  minContextSlot?: number;
}

// Buffered reads add a local wait limit which has no web3.js error type.
export class AccountSyncReadTimeoutError extends Error {
  public readonly accountId: string;
  public readonly commitment: AccountSyncCommitment;
  public readonly timeoutMs: number;
  public readonly minContextSlot?: number;

  constructor(options: AccountSyncReadTimeoutErrorOptions) {
    const minimum =
      options.minContextSlot === undefined
        ? ""
        : ` at or after context slot ${options.minContextSlot}`;
    super(
      `failed to get info about account ${options.accountId}${minimum}: ` +
        `account-sync read timed out after ${options.timeoutMs}ms`
    );
    this.name = "AccountSyncReadTimeoutError";
    this.accountId = options.accountId;
    this.commitment = options.commitment;
    this.timeoutMs = options.timeoutMs;
    this.minContextSlot = options.minContextSlot;
  }
}

export class AccountSyncAccountLimitError extends Error {
  public readonly commitment: AccountSyncCommitment;
  public readonly limit: number;

  constructor(commitment: AccountSyncCommitment, limit: number) {
    super(`account-sync ${commitment} account limit of ${limit} would be exceeded`);
    this.name = "AccountSyncAccountLimitError";
    this.commitment = commitment;
    this.limit = limit;
  }
}
