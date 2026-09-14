import { PublicKey } from "@solana/web3.js";
import type { AccountSyncCommitment, DecodedAccountUpdate } from "../core/types";
import {
  CommitmentLevel,
  SubscribeRequest,
  SubscribeRequestFilterAccounts,
  SubscribeUpdate
} from "../generated/grpc/geyser";

const ACCOUNT_FILTER_NAME = "account-subscription";

export function createSubscribeRequest(
  accountIds: readonly string[],
  commitment: AccountSyncCommitment
): SubscribeRequest {
  const uniqueAccountIds = [...new Set(accountIds.filter((id) => id.length > 0))];
  const subscribeRequest = SubscribeRequest.create({
    commitment: commitmentToProtoValue(commitment)
  });

  if (uniqueAccountIds.length > 0) {
    subscribeRequest.accounts[ACCOUNT_FILTER_NAME] =
      SubscribeRequestFilterAccounts.create({ account: uniqueAccountIds });
  }

  return subscribeRequest;
}

export function subscribeUpdateToAccountUpdate(
  update: SubscribeUpdate
): DecodedAccountUpdate | null {
  const updateAccountEnvelope = update.account;
  const updateAccountInfo = updateAccountEnvelope?.account;
  if (!updateAccountEnvelope || !updateAccountInfo) {
    return null;
  }

  let accountId: string;
  let owner: string;
  try {
    accountId = new PublicKey(updateAccountInfo.pubkey).toBase58();
    owner = new PublicKey(updateAccountInfo.owner).toBase58();
  } catch {
    return null;
  }

  return {
    accountId,
    lamports: updateAccountInfo.lamports,
    owner,
    executable: updateAccountInfo.executable,
    rentEpoch: updateAccountInfo.rentEpoch,
    data: updateAccountInfo.data,
    slot: updateAccountEnvelope.slot,
    writeVersion: updateAccountInfo.writeVersion
  };
}

function commitmentToProtoValue(commitment: AccountSyncCommitment): CommitmentLevel {
  switch (commitment) {
    case "processed":
      return CommitmentLevel.PROCESSED;
    case "confirmed":
      return CommitmentLevel.CONFIRMED;
    case "finalized":
      return CommitmentLevel.FINALIZED;
  }
}
