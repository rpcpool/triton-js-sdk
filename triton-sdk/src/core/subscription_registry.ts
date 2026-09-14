// What: Tracks desired account subscriptions for one SDK connection.
// Why: Runtime add/remove APIs need deterministic full-set state.
// How: Store account ids in a set and expose immutable snapshots.
export class SubscriptionRegistry {
  private readonly accountIds = new Set<string>();

  constructor(initialAccountIds: readonly string[]) {
    for (const accountId of initialAccountIds) {
      if (accountId.length > 0) {
        this.accountIds.add(accountId);
      }
    }
  }

  // What: Replaces tracked accounts with a new set.
  // Why: Caller may want explicit reset semantics.
  // How: Clear internal set and insert non-empty ids.
  public set(accountIds: readonly string[]): boolean {
    const nextSet = new Set(accountIds.filter((accountId) => accountId.length > 0));
    if (areSetsEqual(this.accountIds, nextSet)) {
      return false;
    }

    this.accountIds.clear();
    for (const accountId of nextSet) {
      this.accountIds.add(accountId);
    }
    return true;
  }

  // What: Adds accounts to current desired subscription set.
  // Why: Supports runtime account enrollment without resetting all subscriptions.
  // How: Insert each non-empty account id into internal set.
  public add(accountIds: readonly string[]): boolean {
    let didChange = false;
    for (const accountId of accountIds) {
      if (accountId.length === 0) {
        continue;
      }

      if (!this.accountIds.has(accountId)) {
        this.accountIds.add(accountId);
        didChange = true;
      }
    }

    return didChange;
  }

  // What: Removes accounts from current desired subscription set.
  // Why: Supports runtime account unenrollment.
  // How: Delete each account id from internal set.
  public remove(accountIds: readonly string[]): boolean {
    let didChange = false;
    for (const accountId of accountIds) {
      if (this.accountIds.delete(accountId)) {
        didChange = true;
      }
    }

    return didChange;
  }

  // What: Checks whether an account is already part of this subscription set.
  // Why: Reads can wait on existing subscriptions without sending duplicate updates.
  // How: Direct set lookup by account id.
  public has(accountId: string): boolean {
    return this.accountIds.has(accountId);
  }

  // What: Returns immutable snapshot of tracked accounts.
  // Why: Transports consume snapshots when applying subscriptions.
  // How: Clone set into array to avoid accidental mutation.
  public snapshot(): readonly string[] {
    return [...this.accountIds];
  }
}

function areSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }

  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }

  return true;
}
