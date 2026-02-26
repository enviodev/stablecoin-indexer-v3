import { describe, it, expect } from "vitest";
import { TestHelpers, createTestIndexer, type Account } from "generated";
import "./handlers/ERC20.js";

const { MockDb, ERC20, Addresses } = TestHelpers;

const USDC_ADDRESS = "0x078D782b760474a361dDA0AF3839290b0EF57AD6";
const MOCK_CHAIN_ID = 130;

// Integration tests require network access to HyperSync.
// Run with: INTEGRATION=1 pnpm test
describe.runIf(process.env.INTEGRATION)(
  "Integration: Unichain stablecoin transfers",
  () => {
    it(
      "Should process transfers and create correct entities",
      async () => {
        const indexer = createTestIndexer();

        const result = await indexer.process({
          chains: {
            130: {
              startBlock: 0,
              endBlock: 1_000,
            },
          },
        });

        expect(result.changes.length).toBeGreaterThan(0);

        // --- COMMENTED OUT: Transfer entity removed ---
        // const firstChange = result.changes[0]!;
        // const transfers = firstChange.Transfer?.sets;
        // if (transfers) {
        //   expect(transfers.length).toBeGreaterThan(0);
        //   expect(transfers[0]!.chainId).toBe(130);
        //   expect(transfers[0]!.token).toBeDefined();
        //   expect(transfers[0]!.txHash).toBeDefined();
        //   expect(["TRANSFER", "MINT", "BURN"]).toContain(
        //     transfers[0]!.transferType
        //   );
        // }
      },
      60_000
    );
  }
);

describe("Unit: Transfer handler", () => {
  it("Regular transfer updates all entities correctly", async () => {
    const mockDbEmpty = MockDb.createMockDb();

    const userAddress1 = Addresses.mockAddresses[0]!;
    const userAddress2 = Addresses.mockAddresses[1]!;

    const mockAccountEntity: Account = {
      id: `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${userAddress1}`,
      chainId: MOCK_CHAIN_ID,
      token: USDC_ADDRESS,
      address: userAddress1,
      balance: 5000000n,
      totalVolumeIn: 5000000n,
      totalVolumeOut: 0n,
      transfersIn: 1,
      transfersOut: 0,
      // firstSeenBlock: 100,    // COMMENTED OUT: field removed from schema
      firstSeenTimestamp: 1000000,
      // lastActiveBlock: 100,   // COMMENTED OUT: field removed from schema
      lastActiveTimestamp: 1000000,
    };

    const mockDb = mockDbEmpty.entities.Account.set(mockAccountEntity);

    const mockTransfer = ERC20.Transfer.createMockEvent({
      from: userAddress1,
      to: userAddress2,
      value: 3000000n,
      mockEventData: { srcAddress: USDC_ADDRESS, chainId: MOCK_CHAIN_ID },
    });

    const result = await ERC20.Transfer.processEvent({
      event: mockTransfer,
      mockDb,
    });

    // Sender balance decreased, volume tracked
    const senderAccount = result.entities.Account.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${userAddress1}`
    );
    expect(senderAccount?.balance).toBe(2000000n);
    expect(senderAccount?.totalVolumeOut).toBe(3000000n);
    expect(senderAccount?.transfersOut).toBe(1);

    // Receiver created with correct balance + volume
    const receiverAccount = result.entities.Account.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${userAddress2}`
    );
    expect(receiverAccount?.balance).toBe(3000000n);
    expect(receiverAccount?.totalVolumeIn).toBe(3000000n);
    expect(receiverAccount?.transfersIn).toBe(1);

    // --- COMMENTED OUT: Transfer entity removed ---
    // const transferId = `${MOCK_CHAIN_ID}_${USDC_ADDRESS}_${mockTransfer.block.number}_${mockTransfer.logIndex}`;
    // const transferEntity = result.entities.Transfer.get(transferId);
    // expect(transferEntity).toBeDefined();
    // expect(transferEntity?.transferType).toBe("TRANSFER");
    // expect(transferEntity?.value).toBe(3000000n);
    // expect(transferEntity?.token).toBe(USDC_ADDRESS);

    // TokenSupply — holderCount should be 1 (sender kept balance, receiver is new non-zero holder)
    const supply = result.entities.TokenSupply.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-supply`
    );
    expect(supply?.transferCount).toBe(1);
    expect(supply?.allTimeVolume).toBe(3000000n);
    expect(supply?.holderCount).toBe(1);

    // --- COMMENTED OUT: HourlySnapshot removed ---
    // const hourId = Math.floor(mockTransfer.block.timestamp / 3600);
    // const hourly = result.entities.HourlySnapshot.get(
    //   `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${hourId}`
    // );
    // expect(hourly?.transferCount).toBe(1);
    // expect(hourly?.volume).toBe(3000000n);
    // expect(hourly?.netMintBurnFlow).toBe(0n);

    // DailySnapshot — unique addresses
    const dayId = Math.floor(mockTransfer.block.timestamp / 86400);
    const daily = result.entities.DailySnapshot.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${dayId}`
    );
    expect(daily?.dailyTransferCount).toBe(1);
    expect(daily?.dailyVolume).toBe(3000000n);
    expect(daily?.uniqueActiveAddresses).toBe(2);
    // expect(daily?.netMintBurnFlow).toBe(0n);         // COMMENTED OUT: field removed
    // expect(daily?.newAddressCount).toBe(1);           // COMMENTED OUT: field removed

    // --- COMMENTED OUT: WeeklySnapshot removed ---
    // const weekId = Math.floor(mockTransfer.block.timestamp / 604800);
    // const weekly = result.entities.WeeklySnapshot.get(
    //   `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${weekId}`
    // );
    // expect(weekly?.weeklyTransferCount).toBe(1);
    // expect(weekly?.uniqueActiveAddresses).toBe(2);

    // --- COMMENTED OUT: CrossTokenDailySnapshot removed ---
    // const crossDaily = result.entities.CrossTokenDailySnapshot.get(
    //   `${MOCK_CHAIN_ID}-${dayId}`
    // );
    // expect(crossDaily).toBeDefined();
    // expect(crossDaily?.totalVolume).toBe(3000000n);
    // expect(crossDaily?.totalTransferCount).toBe(1);
    // expect(crossDaily?.netMintBurnFlow).toBe(0n);

    // AccountBalanceSnapshot for sender
    const senderSnap = result.entities.AccountBalanceSnapshot.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${userAddress1}-${mockTransfer.block.number}-${mockTransfer.logIndex}`
    );
    expect(senderSnap?.balance).toBe(2000000n);
    expect(senderSnap?.balanceChange).toBe(-3000000n);

    // AccountBalanceSnapshot for receiver
    const receiverSnap = result.entities.AccountBalanceSnapshot.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${userAddress2}-${mockTransfer.block.number}-${mockTransfer.logIndex}`
    );
    expect(receiverSnap?.balance).toBe(3000000n);
    expect(receiverSnap?.balanceChange).toBe(3000000n);
  });

  it("Mint increases supply, tracks net flow, skips sender", async () => {
    const mockDb = MockDb.createMockDb();
    const receiver = Addresses.mockAddresses[0]!;
    const zeroAddress = "0x0000000000000000000000000000000000000000";

    const mockMint = ERC20.Transfer.createMockEvent({
      from: zeroAddress,
      to: receiver,
      value: 1000000n,
      mockEventData: { srcAddress: USDC_ADDRESS, chainId: MOCK_CHAIN_ID },
    });

    const result = await ERC20.Transfer.processEvent({
      event: mockMint,
      mockDb,
    });

    // --- COMMENTED OUT: Transfer entity removed ---
    // const transferId = `${MOCK_CHAIN_ID}_${USDC_ADDRESS}_${mockMint.block.number}_${mockMint.logIndex}`;
    // expect(result.entities.Transfer.get(transferId)?.transferType).toBe("MINT");

    // No zero address account
    expect(
      result.entities.Account.get(`${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${zeroAddress}`)
    ).toBeUndefined();

    // Receiver balance + volume
    const receiverAccount = result.entities.Account.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${receiver}`
    );
    expect(receiverAccount?.balance).toBe(1000000n);
    expect(receiverAccount?.totalVolumeIn).toBe(1000000n);

    // TokenSupply — holderCount = 1
    const supply = result.entities.TokenSupply.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-supply`
    );
    expect(supply?.totalSupply).toBe(1000000n);
    expect(supply?.totalMinted).toBe(1000000n);
    expect(supply?.allTimeVolume).toBe(1000000n);
    expect(supply?.holderCount).toBe(1);

    // --- COMMENTED OUT: HourlySnapshot removed ---
    // const hourId = Math.floor(mockMint.block.timestamp / 3600);
    // const hourly = result.entities.HourlySnapshot.get(
    //   `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${hourId}`
    // );
    // expect(hourly?.mintVolume).toBe(1000000n);
    // expect(hourly?.netMintBurnFlow).toBe(1000000n);

    // Balance snapshot for receiver only (no sender snapshot for mints)
    const receiverSnap = result.entities.AccountBalanceSnapshot.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${receiver}-${mockMint.block.number}-${mockMint.logIndex}`
    );
    expect(receiverSnap?.balance).toBe(1000000n);
    expect(receiverSnap?.balanceChange).toBe(1000000n);
  });

  it("Burn decreases supply, tracks negative net flow", async () => {
    const mockDbEmpty = MockDb.createMockDb();
    const sender = Addresses.mockAddresses[0]!;
    const zeroAddress = "0x0000000000000000000000000000000000000000";

    const mockDb = mockDbEmpty.entities.Account.set({
      id: `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${sender}`,
      chainId: MOCK_CHAIN_ID,
      token: USDC_ADDRESS,
      address: sender,
      balance: 5000000n,
      totalVolumeIn: 5000000n,
      totalVolumeOut: 0n,
      transfersIn: 1,
      transfersOut: 0,
      // firstSeenBlock: 100,    // COMMENTED OUT: field removed from schema
      firstSeenTimestamp: 1000000,
      // lastActiveBlock: 100,   // COMMENTED OUT: field removed from schema
      lastActiveTimestamp: 1000000,
    });

    const mockBurn = ERC20.Transfer.createMockEvent({
      from: sender,
      to: zeroAddress,
      value: 2000000n,
      mockEventData: { srcAddress: USDC_ADDRESS, chainId: MOCK_CHAIN_ID },
    });

    const result = await ERC20.Transfer.processEvent({
      event: mockBurn,
      mockDb,
    });

    // --- COMMENTED OUT: Transfer entity removed ---
    // const transferId = `${MOCK_CHAIN_ID}_${USDC_ADDRESS}_${mockBurn.block.number}_${mockBurn.logIndex}`;
    // expect(result.entities.Transfer.get(transferId)?.transferType).toBe("BURN");

    // No zero address account
    expect(
      result.entities.Account.get(`${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${zeroAddress}`)
    ).toBeUndefined();

    // Sender balance decreased
    expect(
      result.entities.Account.get(`${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${sender}`)?.balance
    ).toBe(3000000n);

    // TokenSupply
    const supply = result.entities.TokenSupply.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-supply`
    );
    expect(supply?.totalBurned).toBe(2000000n);
    expect(supply?.allTimeVolume).toBe(2000000n);

    // --- COMMENTED OUT: WeeklySnapshot removed ---
    // const weekId = Math.floor(mockBurn.block.timestamp / 604800);
    // const weekly = result.entities.WeeklySnapshot.get(
    //   `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${weekId}`
    // );
    // expect(weekly?.weeklyBurnVolume).toBe(2000000n);
    // expect(weekly?.netMintBurnFlow).toBe(-2000000n);
    // expect(weekly?.uniqueActiveAddresses).toBe(1);

    // Balance snapshot for sender (no receiver snapshot for burns)
    const senderSnap = result.entities.AccountBalanceSnapshot.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${sender}-${mockBurn.block.number}-${mockBurn.logIndex}`
    );
    expect(senderSnap?.balance).toBe(3000000n);
    expect(senderSnap?.balanceChange).toBe(-2000000n);
  });
});
