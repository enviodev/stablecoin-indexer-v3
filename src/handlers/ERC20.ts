import { ERC20, BigDecimal } from "generated";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const HOUR = 3600;
const DAY = 86400;
const WEEK = 604800;

// Threshold for balance snapshots: only snapshot when balance changes by >0.1%
// or crosses a round-number boundary, or goes to/from zero.
const BALANCE_CHANGE_THRESHOLD_BPS = 10n; // 0.1% = 10 basis points out of 10000

// Round-number boundaries for snapshot triggers (in token base units, assuming 6 decimals)
const ROUND_BOUNDARIES = [
  10_000n * 1_000_000n,   // 10k tokens
  100_000n * 1_000_000n,  // 100k tokens
  1_000_000n * 1_000_000n, // 1M tokens
  10_000_000n * 1_000_000n, // 10M tokens
];

function getAccountId(chainId: number, token: string, address: string): string {
  return `${chainId}-${token}-${address}`;
}

/**
 * Determine if a balance change warrants a snapshot.
 * Always snapshot when:
 * - Balance goes to zero (account emptied)
 * - Balance comes from zero (account funded)
 * - Balance changes by >0.1% of the previous balance
 * - Balance crosses a round-number boundary
 */
function shouldSnapshot(oldBalance: bigint, newBalance: bigint): boolean {
  // Always snapshot zero transitions
  if (oldBalance === 0n || newBalance === 0n) return true;

  // Check percentage change: |change| * 10000 > oldBalance * threshold
  const change = newBalance > oldBalance ? newBalance - oldBalance : oldBalance - newBalance;
  if (change * 10000n > (oldBalance < 0n ? -oldBalance : oldBalance) * BALANCE_CHANGE_THRESHOLD_BPS) {
    return true;
  }

  // Check if crossed any round-number boundary
  for (const boundary of ROUND_BOUNDARIES) {
    if ((oldBalance < boundary && newBalance >= boundary) ||
        (oldBalance >= boundary && newBalance < boundary)) {
      return true;
    }
  }

  return false;
}

/**
 * Compute velocity as volume / supply. Returns BigDecimal.
 * Returns 0 if supply is zero.
 */
function computeVelocity(volume: bigint, supply: bigint): BigDecimal {
  if (supply === 0n) return new BigDecimal(0);
  return new BigDecimal(volume.toString()).dividedBy(new BigDecimal(supply.toString()));
}

/**
 * Track a unique address for a time period. Returns true if this is
 * the first time the address appeared in this period (new unique).
 */
async function trackUnique(
  entity: { get: (id: string) => Promise<{ id: string } | undefined>; set: (v: { id: string }) => void },
  id: string,
): Promise<boolean> {
  const existing = await entity.get(id);
  if (existing) return false;
  entity.set({ id });
  return true;
}

ERC20.Transfer.handler(async ({ event, context }) => {
  const chainId = event.chainId;
  const token = event.srcAddress;
  const from = event.params.from;
  const to = event.params.to;
  const value = event.params.value;
  const blockNumber = event.block.number;
  const ts = event.block.timestamp;

  const isMint = from === ZERO_ADDRESS;
  const isBurn = to === ZERO_ADDRESS;
  const transferType = isMint ? "MINT" : isBurn ? "BURN" : "TRANSFER";

  // 1. Save Transfer entity
  context.Transfer.set({
    id: `${chainId}_${token}_${blockNumber}_${event.logIndex}`,
    chainId,
    token,
    blockNumber,
    blockTimestamp: ts,
    logIndex: event.logIndex,
    txHash: event.transaction.hash,
    from,
    to,
    value,
    transferType,
  });

  // --- Track holder count changes and new addresses ---
  let holderDelta = 0;
  let newAddresses = 0;

  // 2. Update sender Account (skip for mints)
  if (!isMint) {
    const senderId = getAccountId(chainId, token, from);
    const sender = await context.Account.get(senderId);
    const oldBalance = sender?.balance ?? 0n;
    const newBalance = oldBalance - value;

    if (!sender) newAddresses++;
    if (oldBalance !== 0n && newBalance === 0n) holderDelta--;
    if (oldBalance === 0n && newBalance !== 0n) holderDelta++;

    if (sender) {
      context.Account.set({
        ...sender,
        balance: newBalance,
        totalVolumeOut: sender.totalVolumeOut + value,
        transfersOut: sender.transfersOut + 1,
        lastActiveBlock: blockNumber,
        lastActiveTimestamp: ts,
      });
    } else {
      context.Account.set({
        id: senderId,
        chainId,
        token,
        address: from,
        balance: newBalance,
        totalVolumeIn: 0n,
        totalVolumeOut: value,
        transfersIn: 0,
        transfersOut: 1,
        firstSeenBlock: blockNumber,
        firstSeenTimestamp: ts,
        lastActiveBlock: blockNumber,
        lastActiveTimestamp: ts,
      });
    }

    // Threshold-based balance snapshot for sender
    if (shouldSnapshot(oldBalance, newBalance)) {
      context.AccountBalanceSnapshot.set({
        id: `${chainId}-${token}-${from}-${blockNumber}-${event.logIndex}`,
        chainId,
        token,
        account: from,
        blockNumber,
        blockTimestamp: ts,
        balance: newBalance,
        balanceChange: 0n - value,
        txHash: event.transaction.hash,
      });
    }
  }

  // 3. Update receiver Account (skip for burns)
  if (!isBurn) {
    const receiverId = getAccountId(chainId, token, to);
    const receiver = await context.Account.get(receiverId);
    const oldBalance = receiver?.balance ?? 0n;
    const newBalance = oldBalance + value;

    if (!receiver) newAddresses++;
    if (oldBalance !== 0n && newBalance === 0n) holderDelta--;
    if (oldBalance === 0n && newBalance !== 0n) holderDelta++;

    if (receiver) {
      context.Account.set({
        ...receiver,
        balance: newBalance,
        totalVolumeIn: receiver.totalVolumeIn + value,
        transfersIn: receiver.transfersIn + 1,
        lastActiveBlock: blockNumber,
        lastActiveTimestamp: ts,
      });
    } else {
      context.Account.set({
        id: receiverId,
        chainId,
        token,
        address: to,
        balance: newBalance,
        totalVolumeIn: value,
        totalVolumeOut: 0n,
        transfersIn: 1,
        transfersOut: 0,
        firstSeenBlock: blockNumber,
        firstSeenTimestamp: ts,
        lastActiveBlock: blockNumber,
        lastActiveTimestamp: ts,
      });
    }

    // Threshold-based balance snapshot for receiver
    if (shouldSnapshot(oldBalance, newBalance)) {
      context.AccountBalanceSnapshot.set({
        id: `${chainId}-${token}-${to}-${blockNumber}-${event.logIndex}`,
        chainId,
        token,
        account: to,
        blockNumber,
        blockTimestamp: ts,
        balance: newBalance,
        balanceChange: value,
        txHash: event.transaction.hash,
      });
    }
  }

  // 4. Update TokenSupply
  const supplyId = `${chainId}-${token}-supply`;
  const supply = await context.TokenSupply.get(supplyId);
  const mintVal = isMint ? value : 0n;
  const burnVal = isBurn ? value : 0n;

  // Compute currentTotalSupply locally to avoid redundant re-read
  let currentTotalSupply: bigint;
  if (supply) {
    currentTotalSupply = supply.totalSupply + mintVal - burnVal;
    context.TokenSupply.set({
      ...supply,
      totalSupply: currentTotalSupply,
      totalMinted: supply.totalMinted + mintVal,
      totalBurned: supply.totalBurned + burnVal,
      allTimeVolume: supply.allTimeVolume + value,
      holderCount: supply.holderCount + holderDelta,
      mintCount: supply.mintCount + (isMint ? 1 : 0),
      burnCount: supply.burnCount + (isBurn ? 1 : 0),
      transferCount: supply.transferCount + 1,
      lastUpdatedBlock: blockNumber,
      lastUpdatedTimestamp: ts,
    });
  } else {
    currentTotalSupply = mintVal - burnVal;
    context.TokenSupply.set({
      id: supplyId,
      chainId,
      token,
      totalSupply: currentTotalSupply,
      totalMinted: mintVal,
      totalBurned: burnVal,
      allTimeVolume: value,
      holderCount: holderDelta,
      mintCount: isMint ? 1 : 0,
      burnCount: isBurn ? 1 : 0,
      transferCount: 1,
      lastUpdatedBlock: blockNumber,
      lastUpdatedTimestamp: ts,
    });
  }

  const netFlow = mintVal - burnVal;

  // --- Unique address tracking per period (daily + weekly only) ---
  const hourId = Math.floor(ts / HOUR);
  const dayId = Math.floor(ts / DAY);
  const weekId = Math.floor(ts / WEEK);

  let dailyUniques = 0;
  let weeklyUniques = 0;

  // Track each non-zero address involved
  const addresses: string[] = [];
  if (!isMint) addresses.push(from);
  if (!isBurn) addresses.push(to);

  for (const addr of addresses) {
    if (await trackUnique(context.DailyActiveAddress, `${chainId}-${token}-${dayId}-${addr}`))
      dailyUniques++;
    if (await trackUnique(context.WeeklyActiveAddress, `${chainId}-${token}-${weekId}-${addr}`))
      weeklyUniques++;
  }

  // 5. HourlySnapshot
  const hourlyId = `${chainId}-${token}-${hourId}`;
  const hourly = await context.HourlySnapshot.get(hourlyId);
  if (hourly) {
    context.HourlySnapshot.set({
      ...hourly,
      volume: hourly.volume + value,
      transferCount: hourly.transferCount + 1,
      mintVolume: hourly.mintVolume + mintVal,
      burnVolume: hourly.burnVolume + burnVal,
      netMintBurnFlow: hourly.netMintBurnFlow + netFlow,
      mintCount: hourly.mintCount + (isMint ? 1 : 0),
      burnCount: hourly.burnCount + (isBurn ? 1 : 0),
      endOfHourSupply: currentTotalSupply,
      lastBlockOfHour: blockNumber,
    });
  } else {
    context.HourlySnapshot.set({
      id: hourlyId,
      chainId,
      token,
      hourId,
      hourStartTimestamp: hourId * HOUR,
      volume: value,
      transferCount: 1,
      mintVolume: mintVal,
      burnVolume: burnVal,
      netMintBurnFlow: netFlow,
      mintCount: isMint ? 1 : 0,
      burnCount: isBurn ? 1 : 0,
      endOfHourSupply: currentTotalSupply,
      firstBlockOfHour: blockNumber,
      lastBlockOfHour: blockNumber,
    });
  }

  // 6. DailySnapshot (with velocity)
  const dailyId = `${chainId}-${token}-${dayId}`;
  const daily = await context.DailySnapshot.get(dailyId);
  if (daily) {
    const updatedVolume = daily.dailyVolume + value;
    context.DailySnapshot.set({
      ...daily,
      dailyVolume: updatedVolume,
      dailyTransferCount: daily.dailyTransferCount + 1,
      dailyMintVolume: daily.dailyMintVolume + mintVal,
      dailyBurnVolume: daily.dailyBurnVolume + burnVal,
      netMintBurnFlow: daily.netMintBurnFlow + netFlow,
      dailyMintCount: daily.dailyMintCount + (isMint ? 1 : 0),
      dailyBurnCount: daily.dailyBurnCount + (isBurn ? 1 : 0),
      uniqueActiveAddresses: daily.uniqueActiveAddresses + dailyUniques,
      newAddressCount: daily.newAddressCount + newAddresses,
      endOfDaySupply: currentTotalSupply,
      velocity: computeVelocity(updatedVolume, currentTotalSupply),
      lastBlockOfDay: blockNumber,
    });
  } else {
    context.DailySnapshot.set({
      id: dailyId,
      chainId,
      token,
      dayId,
      dayStartTimestamp: dayId * DAY,
      dailyVolume: value,
      dailyTransferCount: 1,
      dailyMintVolume: mintVal,
      dailyBurnVolume: burnVal,
      netMintBurnFlow: netFlow,
      dailyMintCount: isMint ? 1 : 0,
      dailyBurnCount: isBurn ? 1 : 0,
      uniqueActiveAddresses: dailyUniques,
      newAddressCount: newAddresses,
      endOfDaySupply: currentTotalSupply,
      velocity: computeVelocity(value, currentTotalSupply),
      firstBlockOfDay: blockNumber,
      lastBlockOfDay: blockNumber,
    });
  }

  // 7. WeeklySnapshot (with velocity)
  const weeklyId = `${chainId}-${token}-${weekId}`;
  const weekly = await context.WeeklySnapshot.get(weeklyId);
  if (weekly) {
    const updatedVolume = weekly.weeklyVolume + value;
    context.WeeklySnapshot.set({
      ...weekly,
      weeklyVolume: updatedVolume,
      weeklyTransferCount: weekly.weeklyTransferCount + 1,
      weeklyMintVolume: weekly.weeklyMintVolume + mintVal,
      weeklyBurnVolume: weekly.weeklyBurnVolume + burnVal,
      netMintBurnFlow: weekly.netMintBurnFlow + netFlow,
      weeklyMintCount: weekly.weeklyMintCount + (isMint ? 1 : 0),
      weeklyBurnCount: weekly.weeklyBurnCount + (isBurn ? 1 : 0),
      uniqueActiveAddresses: weekly.uniqueActiveAddresses + weeklyUniques,
      endOfWeekSupply: currentTotalSupply,
      velocity: computeVelocity(updatedVolume, currentTotalSupply),
      lastBlockOfWeek: blockNumber,
    });
  } else {
    context.WeeklySnapshot.set({
      id: weeklyId,
      chainId,
      token,
      weekId,
      weekStartTimestamp: weekId * WEEK,
      weeklyVolume: value,
      weeklyTransferCount: 1,
      weeklyMintVolume: mintVal,
      weeklyBurnVolume: burnVal,
      netMintBurnFlow: netFlow,
      weeklyMintCount: isMint ? 1 : 0,
      weeklyBurnCount: isBurn ? 1 : 0,
      uniqueActiveAddresses: weeklyUniques,
      endOfWeekSupply: currentTotalSupply,
      velocity: computeVelocity(value, currentTotalSupply),
      firstBlockOfWeek: blockNumber,
      lastBlockOfWeek: blockNumber,
    });
  }

  // 8. CrossTokenDailySnapshot (aggregated across all tokens)
  const crossDailyId = `${chainId}-${dayId}`;
  const crossDaily = await context.CrossTokenDailySnapshot.get(crossDailyId);
  if (crossDaily) {
    context.CrossTokenDailySnapshot.set({
      ...crossDaily,
      totalVolume: crossDaily.totalVolume + value,
      totalTransferCount: crossDaily.totalTransferCount + 1,
      totalMintVolume: crossDaily.totalMintVolume + mintVal,
      totalBurnVolume: crossDaily.totalBurnVolume + burnVal,
      netMintBurnFlow: crossDaily.netMintBurnFlow + netFlow,
    });
  } else {
    context.CrossTokenDailySnapshot.set({
      id: crossDailyId,
      chainId,
      dayId,
      dayStartTimestamp: dayId * DAY,
      totalVolume: value,
      totalTransferCount: 1,
      totalMintVolume: mintVal,
      totalBurnVolume: burnVal,
      netMintBurnFlow: netFlow,
    });
  }

  // 9. AccountDailyActivity for sender (skip for mints)
  if (!isMint) {
    const senderActivityId = `${chainId}-${token}-${from}-${dayId}`;
    const senderActivity = await context.AccountDailyActivity.get(senderActivityId);
    if (senderActivity) {
      context.AccountDailyActivity.set({
        ...senderActivity,
        transferCount: senderActivity.transferCount + 1,
        volumeOut: senderActivity.volumeOut + value,
      });
    } else {
      context.AccountDailyActivity.set({
        id: senderActivityId,
        chainId,
        token,
        account: from,
        dayId,
        transferCount: 1,
        volumeIn: 0n,
        volumeOut: value,
      });
    }
  }

  // 9b. AccountDailyActivity for receiver (skip for burns)
  if (!isBurn) {
    const receiverActivityId = `${chainId}-${token}-${to}-${dayId}`;
    const receiverActivity = await context.AccountDailyActivity.get(receiverActivityId);
    if (receiverActivity) {
      context.AccountDailyActivity.set({
        ...receiverActivity,
        transferCount: receiverActivity.transferCount + 1,
        volumeIn: receiverActivity.volumeIn + value,
      });
    } else {
      context.AccountDailyActivity.set({
        id: receiverActivityId,
        chainId,
        token,
        account: to,
        dayId,
        transferCount: 1,
        volumeIn: value,
        volumeOut: 0n,
      });
    }
  }
});

ERC20.Approval.handler(async ({ event, context }) => {
  const chainId = event.chainId;
  const token = event.srcAddress;
  const owner = event.params.owner;
  const spender = event.params.spender;
  const blockNumber = event.block.number;
  const ts = event.block.timestamp;

  // 1. Ensure owner Account exists
  const ownerId = getAccountId(chainId, token, owner);
  await context.Account.getOrCreate({
    id: ownerId,
    chainId,
    token,
    address: owner,
    balance: 0n,
    totalVolumeIn: 0n,
    totalVolumeOut: 0n,
    transfersIn: 0,
    transfersOut: 0,
    firstSeenBlock: blockNumber,
    firstSeenTimestamp: ts,
    lastActiveBlock: blockNumber,
    lastActiveTimestamp: ts,
  });

  // 2. Ensure spender Account exists
  const spenderId = getAccountId(chainId, token, spender);
  await context.Account.getOrCreate({
    id: spenderId,
    chainId,
    token,
    address: spender,
    balance: 0n,
    totalVolumeIn: 0n,
    totalVolumeOut: 0n,
    transfersIn: 0,
    transfersOut: 0,
    firstSeenBlock: blockNumber,
    firstSeenTimestamp: ts,
    lastActiveBlock: blockNumber,
    lastActiveTimestamp: ts,
  });

  // 3. Set/overwrite Approval entity
  const approvalId = `${chainId}-${token}-${owner}-${spender}`;
  context.Approval.set({
    id: approvalId,
    chainId,
    token,
    amount: event.params.value,
    owner_id: ownerId,
    spender_id: spenderId,
    lastUpdatedBlock: blockNumber,
    lastUpdatedTimestamp: ts,
  });
});
