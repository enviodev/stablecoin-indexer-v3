import {
  ERC20,
  type Account,
  type Approval,
  type Transfer,
  type ChainSupply,
  type DailySnapshot,
  type AccountDailyActivity,
} from "generated";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function getAccountId(chainId: number, address: string): string {
  return `${chainId}-${address}`;
}

function getDayId(blockTimestamp: number): number {
  return Math.floor(blockTimestamp / 86400);
}

ERC20.Transfer.handler(async ({ event, context }) => {
  const chainId = event.chainId;
  const from = event.params.from;
  const to = event.params.to;
  const value = event.params.value;
  const blockNumber = event.block.number;
  const blockTimestamp = event.block.timestamp;

  const isMint = from === ZERO_ADDRESS;
  const isBurn = to === ZERO_ADDRESS;
  const transferType = isMint ? "MINT" : isBurn ? "BURN" : "TRANSFER";

  // 1. Save Transfer entity
  const transfer: Transfer = {
    id: `${chainId}_${blockNumber}_${event.logIndex}`,
    chainId,
    blockNumber,
    blockTimestamp,
    logIndex: event.logIndex,
    txHash: event.transaction.hash,
    from,
    to,
    value,
    transferType,
  };
  context.Transfer.set(transfer);

  // 2. Update sender Account (skip for mints)
  if (!isMint) {
    const senderId = getAccountId(chainId, from);
    const sender = await context.Account.get(senderId);
    if (sender) {
      context.Account.set({
        ...sender,
        balance: sender.balance - value,
        transfersOut: sender.transfersOut + 1,
        lastActiveBlock: blockNumber,
        lastActiveTimestamp: blockTimestamp,
      });
    } else {
      context.Account.set({
        id: senderId,
        chainId,
        address: from,
        balance: 0n - value,
        transfersIn: 0,
        transfersOut: 1,
        firstSeenBlock: blockNumber,
        firstSeenTimestamp: blockTimestamp,
        lastActiveBlock: blockNumber,
        lastActiveTimestamp: blockTimestamp,
      });
    }
  }

  // 3. Update receiver Account (skip for burns)
  if (!isBurn) {
    const receiverId = getAccountId(chainId, to);
    const receiver = await context.Account.get(receiverId);
    if (receiver) {
      context.Account.set({
        ...receiver,
        balance: receiver.balance + value,
        transfersIn: receiver.transfersIn + 1,
        lastActiveBlock: blockNumber,
        lastActiveTimestamp: blockTimestamp,
      });
    } else {
      context.Account.set({
        id: receiverId,
        chainId,
        address: to,
        balance: value,
        transfersIn: 1,
        transfersOut: 0,
        firstSeenBlock: blockNumber,
        firstSeenTimestamp: blockTimestamp,
        lastActiveBlock: blockNumber,
        lastActiveTimestamp: blockTimestamp,
      });
    }
  }

  // 4. Update ChainSupply singleton
  const supplyId = `${chainId}-supply`;
  const supply = await context.ChainSupply.get(supplyId);
  if (supply) {
    context.ChainSupply.set({
      ...supply,
      totalSupply: supply.totalSupply + (isMint ? value : 0n) - (isBurn ? value : 0n),
      totalMinted: supply.totalMinted + (isMint ? value : 0n),
      totalBurned: supply.totalBurned + (isBurn ? value : 0n),
      mintCount: supply.mintCount + (isMint ? 1 : 0),
      burnCount: supply.burnCount + (isBurn ? 1 : 0),
      transferCount: supply.transferCount + 1,
      lastUpdatedBlock: blockNumber,
      lastUpdatedTimestamp: blockTimestamp,
    });
  } else {
    context.ChainSupply.set({
      id: supplyId,
      chainId,
      totalSupply: isMint ? value : isBurn ? 0n - value : 0n,
      totalMinted: isMint ? value : 0n,
      totalBurned: isBurn ? value : 0n,
      mintCount: isMint ? 1 : 0,
      burnCount: isBurn ? 1 : 0,
      transferCount: 1,
      lastUpdatedBlock: blockNumber,
      lastUpdatedTimestamp: blockTimestamp,
    });
  }

  // 5. Update DailySnapshot
  const dayId = getDayId(blockTimestamp);
  const snapshotId = `${chainId}-${dayId}`;
  const snapshot = await context.DailySnapshot.get(snapshotId);

  // Get current supply for endOfDaySupply
  const currentSupply = await context.ChainSupply.get(supplyId);
  const endOfDaySupply = currentSupply?.totalSupply ?? 0n;

  if (snapshot) {
    context.DailySnapshot.set({
      ...snapshot,
      dailyVolume: snapshot.dailyVolume + value,
      dailyTransferCount: snapshot.dailyTransferCount + 1,
      dailyMintVolume: snapshot.dailyMintVolume + (isMint ? value : 0n),
      dailyBurnVolume: snapshot.dailyBurnVolume + (isBurn ? value : 0n),
      dailyMintCount: snapshot.dailyMintCount + (isMint ? 1 : 0),
      dailyBurnCount: snapshot.dailyBurnCount + (isBurn ? 1 : 0),
      endOfDaySupply,
      lastBlockOfDay: blockNumber,
    });
  } else {
    context.DailySnapshot.set({
      id: snapshotId,
      chainId,
      dayId,
      dayStartTimestamp: dayId * 86400,
      dailyVolume: value,
      dailyTransferCount: 1,
      dailyMintVolume: isMint ? value : 0n,
      dailyBurnVolume: isBurn ? value : 0n,
      dailyMintCount: isMint ? 1 : 0,
      dailyBurnCount: isBurn ? 1 : 0,
      endOfDaySupply,
      firstBlockOfDay: blockNumber,
      lastBlockOfDay: blockNumber,
    });
  }

  // 6. Update AccountDailyActivity for sender (skip for mints)
  if (!isMint) {
    const senderActivityId = `${chainId}-${from}-${dayId}`;
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
        account: from,
        dayId,
        transferCount: 1,
        volumeIn: 0n,
        volumeOut: value,
      });
    }
  }

  // 6b. Update AccountDailyActivity for receiver (skip for burns)
  if (!isBurn) {
    const receiverActivityId = `${chainId}-${to}-${dayId}`;
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
  const owner = event.params.owner;
  const spender = event.params.spender;
  const blockNumber = event.block.number;
  const blockTimestamp = event.block.timestamp;

  // 1. Ensure owner Account exists
  const ownerId = getAccountId(chainId, owner);
  await context.Account.getOrCreate({
    id: ownerId,
    chainId,
    address: owner,
    balance: 0n,
    transfersIn: 0,
    transfersOut: 0,
    firstSeenBlock: blockNumber,
    firstSeenTimestamp: blockTimestamp,
    lastActiveBlock: blockNumber,
    lastActiveTimestamp: blockTimestamp,
  });

  // 2. Ensure spender Account exists
  const spenderId = getAccountId(chainId, spender);
  await context.Account.getOrCreate({
    id: spenderId,
    chainId,
    address: spender,
    balance: 0n,
    transfersIn: 0,
    transfersOut: 0,
    firstSeenBlock: blockNumber,
    firstSeenTimestamp: blockTimestamp,
    lastActiveBlock: blockNumber,
    lastActiveTimestamp: blockTimestamp,
  });

  // 3. Set/overwrite Approval entity
  const approvalId = `${chainId}-${owner}-${spender}`;
  context.Approval.set({
    id: approvalId,
    chainId,
    amount: event.params.value,
    owner_id: ownerId,
    spender_id: spenderId,
    lastUpdatedBlock: blockNumber,
    lastUpdatedTimestamp: blockTimestamp,
  });
});
