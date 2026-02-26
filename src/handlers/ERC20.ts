import {
  ERC20,
  type Account,
  type Approval,
  type Transfer,
  type TokenSupply,
  type HourlySnapshot,
  type DailySnapshot,
  type WeeklySnapshot,
  type AccountDailyActivity,
} from "generated";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const HOUR = 3600;
const DAY = 86400;
const WEEK = 604800;

function getAccountId(chainId: number, token: string, address: string): string {
  return `${chainId}-${token}-${address}`;
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

  // 2. Update sender Account (skip for mints)
  if (!isMint) {
    const senderId = getAccountId(chainId, token, from);
    const sender = await context.Account.get(senderId);
    if (sender) {
      context.Account.set({
        ...sender,
        balance: sender.balance - value,
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
        balance: 0n - value,
        transfersIn: 0,
        transfersOut: 1,
        firstSeenBlock: blockNumber,
        firstSeenTimestamp: ts,
        lastActiveBlock: blockNumber,
        lastActiveTimestamp: ts,
      });
    }
  }

  // 3. Update receiver Account (skip for burns)
  if (!isBurn) {
    const receiverId = getAccountId(chainId, token, to);
    const receiver = await context.Account.get(receiverId);
    if (receiver) {
      context.Account.set({
        ...receiver,
        balance: receiver.balance + value,
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
        balance: value,
        transfersIn: 1,
        transfersOut: 0,
        firstSeenBlock: blockNumber,
        firstSeenTimestamp: ts,
        lastActiveBlock: blockNumber,
        lastActiveTimestamp: ts,
      });
    }
  }

  // 4. Update TokenSupply
  const supplyId = `${chainId}-${token}-supply`;
  const supply = await context.TokenSupply.get(supplyId);
  if (supply) {
    context.TokenSupply.set({
      ...supply,
      totalSupply: supply.totalSupply + (isMint ? value : 0n) - (isBurn ? value : 0n),
      totalMinted: supply.totalMinted + (isMint ? value : 0n),
      totalBurned: supply.totalBurned + (isBurn ? value : 0n),
      mintCount: supply.mintCount + (isMint ? 1 : 0),
      burnCount: supply.burnCount + (isBurn ? 1 : 0),
      transferCount: supply.transferCount + 1,
      lastUpdatedBlock: blockNumber,
      lastUpdatedTimestamp: ts,
    });
  } else {
    context.TokenSupply.set({
      id: supplyId,
      chainId,
      token,
      totalSupply: isMint ? value : isBurn ? 0n - value : 0n,
      totalMinted: isMint ? value : 0n,
      totalBurned: isBurn ? value : 0n,
      mintCount: isMint ? 1 : 0,
      burnCount: isBurn ? 1 : 0,
      transferCount: 1,
      lastUpdatedBlock: blockNumber,
      lastUpdatedTimestamp: ts,
    });
  }

  const currentSupply = await context.TokenSupply.get(supplyId);
  const currentTotalSupply = currentSupply?.totalSupply ?? 0n;

  const mintVal = isMint ? value : 0n;
  const burnVal = isBurn ? value : 0n;

  // 5. HourlySnapshot
  const hourId = Math.floor(ts / HOUR);
  const hourlyId = `${chainId}-${token}-${hourId}`;
  const hourly = await context.HourlySnapshot.get(hourlyId);
  if (hourly) {
    context.HourlySnapshot.set({
      ...hourly,
      volume: hourly.volume + value,
      transferCount: hourly.transferCount + 1,
      mintVolume: hourly.mintVolume + mintVal,
      burnVolume: hourly.burnVolume + burnVal,
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
      mintCount: isMint ? 1 : 0,
      burnCount: isBurn ? 1 : 0,
      endOfHourSupply: currentTotalSupply,
      firstBlockOfHour: blockNumber,
      lastBlockOfHour: blockNumber,
    });
  }

  // 6. DailySnapshot
  const dayId = Math.floor(ts / DAY);
  const dailyId = `${chainId}-${token}-${dayId}`;
  const daily = await context.DailySnapshot.get(dailyId);
  if (daily) {
    context.DailySnapshot.set({
      ...daily,
      dailyVolume: daily.dailyVolume + value,
      dailyTransferCount: daily.dailyTransferCount + 1,
      dailyMintVolume: daily.dailyMintVolume + mintVal,
      dailyBurnVolume: daily.dailyBurnVolume + burnVal,
      dailyMintCount: daily.dailyMintCount + (isMint ? 1 : 0),
      dailyBurnCount: daily.dailyBurnCount + (isBurn ? 1 : 0),
      endOfDaySupply: currentTotalSupply,
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
      dailyMintCount: isMint ? 1 : 0,
      dailyBurnCount: isBurn ? 1 : 0,
      endOfDaySupply: currentTotalSupply,
      firstBlockOfDay: blockNumber,
      lastBlockOfDay: blockNumber,
    });
  }

  // 7. WeeklySnapshot
  const weekId = Math.floor(ts / WEEK);
  const weeklyId = `${chainId}-${token}-${weekId}`;
  const weekly = await context.WeeklySnapshot.get(weeklyId);
  if (weekly) {
    context.WeeklySnapshot.set({
      ...weekly,
      weeklyVolume: weekly.weeklyVolume + value,
      weeklyTransferCount: weekly.weeklyTransferCount + 1,
      weeklyMintVolume: weekly.weeklyMintVolume + mintVal,
      weeklyBurnVolume: weekly.weeklyBurnVolume + burnVal,
      weeklyMintCount: weekly.weeklyMintCount + (isMint ? 1 : 0),
      weeklyBurnCount: weekly.weeklyBurnCount + (isBurn ? 1 : 0),
      endOfWeekSupply: currentTotalSupply,
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
      weeklyMintCount: isMint ? 1 : 0,
      weeklyBurnCount: isBurn ? 1 : 0,
      endOfWeekSupply: currentTotalSupply,
      firstBlockOfWeek: blockNumber,
      lastBlockOfWeek: blockNumber,
    });
  }

  // 8. AccountDailyActivity for sender (skip for mints)
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

  // 8b. AccountDailyActivity for receiver (skip for burns)
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
