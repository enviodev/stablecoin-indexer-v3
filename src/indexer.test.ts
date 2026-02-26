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

        const firstChange = result.changes[0]!;
        const transfers = firstChange.Transfer?.sets;
        if (transfers) {
          expect(transfers.length).toBeGreaterThan(0);
          expect(transfers[0]!.chainId).toBe(130);
          expect(transfers[0]!.token).toBeDefined();
          expect(transfers[0]!.txHash).toBeDefined();
          expect(["TRANSFER", "MINT", "BURN"]).toContain(
            transfers[0]!.transferType
          );
        }
      },
      60_000
    );
  }
);

describe("Unit: Transfer handler", () => {
  it("Regular transfer updates sender and receiver balances", async () => {
    const mockDbEmpty = MockDb.createMockDb();

    const userAddress1 = Addresses.mockAddresses[0]!;
    const userAddress2 = Addresses.mockAddresses[1]!;

    const mockAccountEntity: Account = {
      id: `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${userAddress1}`,
      chainId: MOCK_CHAIN_ID,
      token: USDC_ADDRESS,
      address: userAddress1,
      balance: 5000000n,
      transfersIn: 1,
      transfersOut: 0,
      firstSeenBlock: 100,
      firstSeenTimestamp: 1000000,
      lastActiveBlock: 100,
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

    // Sender balance decreased
    const senderAccount = result.entities.Account.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${userAddress1}`
    );
    expect(senderAccount?.balance).toBe(2000000n);
    expect(senderAccount?.transfersOut).toBe(1);

    // Receiver created with correct balance
    const receiverAccount = result.entities.Account.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${userAddress2}`
    );
    expect(receiverAccount?.balance).toBe(3000000n);
    expect(receiverAccount?.transfersIn).toBe(1);

    // Transfer entity
    const transferId = `${MOCK_CHAIN_ID}_${USDC_ADDRESS}_${mockTransfer.block.number}_${mockTransfer.logIndex}`;
    const transferEntity = result.entities.Transfer.get(transferId);
    expect(transferEntity).toBeDefined();
    expect(transferEntity?.transferType).toBe("TRANSFER");
    expect(transferEntity?.value).toBe(3000000n);
    expect(transferEntity?.token).toBe(USDC_ADDRESS);

    // TokenSupply
    const supply = result.entities.TokenSupply.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-supply`
    );
    expect(supply?.transferCount).toBe(1);
    expect(supply?.token).toBe(USDC_ADDRESS);

    // HourlySnapshot
    const hourId = Math.floor(mockTransfer.block.timestamp / 3600);
    const hourly = result.entities.HourlySnapshot.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${hourId}`
    );
    expect(hourly).toBeDefined();
    expect(hourly?.transferCount).toBe(1);
    expect(hourly?.volume).toBe(3000000n);

    // DailySnapshot
    const dayId = Math.floor(mockTransfer.block.timestamp / 86400);
    const daily = result.entities.DailySnapshot.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${dayId}`
    );
    expect(daily).toBeDefined();
    expect(daily?.dailyTransferCount).toBe(1);
    expect(daily?.dailyVolume).toBe(3000000n);

    // WeeklySnapshot
    const weekId = Math.floor(mockTransfer.block.timestamp / 604800);
    const weekly = result.entities.WeeklySnapshot.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${weekId}`
    );
    expect(weekly).toBeDefined();
    expect(weekly?.weeklyTransferCount).toBe(1);
    expect(weekly?.weeklyVolume).toBe(3000000n);
  });

  it("Mint (from zero address) increases supply and skips sender update", async () => {
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

    // MINT type
    const transferId = `${MOCK_CHAIN_ID}_${USDC_ADDRESS}_${mockMint.block.number}_${mockMint.logIndex}`;
    expect(result.entities.Transfer.get(transferId)?.transferType).toBe("MINT");

    // No zero address account
    expect(
      result.entities.Account.get(`${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${zeroAddress}`)
    ).toBeUndefined();

    // Receiver balance
    expect(
      result.entities.Account.get(`${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${receiver}`)?.balance
    ).toBe(1000000n);

    // TokenSupply
    const supply = result.entities.TokenSupply.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-supply`
    );
    expect(supply?.totalSupply).toBe(1000000n);
    expect(supply?.totalMinted).toBe(1000000n);
    expect(supply?.mintCount).toBe(1);

    // Hourly mint tracking
    const hourId = Math.floor(mockMint.block.timestamp / 3600);
    const hourly = result.entities.HourlySnapshot.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${hourId}`
    );
    expect(hourly?.mintVolume).toBe(1000000n);
    expect(hourly?.mintCount).toBe(1);
  });

  it("Burn (to zero address) decreases supply and skips receiver update", async () => {
    const mockDbEmpty = MockDb.createMockDb();
    const sender = Addresses.mockAddresses[0]!;
    const zeroAddress = "0x0000000000000000000000000000000000000000";

    const mockDb = mockDbEmpty.entities.Account.set({
      id: `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${sender}`,
      chainId: MOCK_CHAIN_ID,
      token: USDC_ADDRESS,
      address: sender,
      balance: 5000000n,
      transfersIn: 1,
      transfersOut: 0,
      firstSeenBlock: 100,
      firstSeenTimestamp: 1000000,
      lastActiveBlock: 100,
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

    // BURN type
    const transferId = `${MOCK_CHAIN_ID}_${USDC_ADDRESS}_${mockBurn.block.number}_${mockBurn.logIndex}`;
    expect(result.entities.Transfer.get(transferId)?.transferType).toBe("BURN");

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
    expect(supply?.burnCount).toBe(1);

    // Weekly burn tracking
    const weekId = Math.floor(mockBurn.block.timestamp / 604800);
    const weekly = result.entities.WeeklySnapshot.get(
      `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${weekId}`
    );
    expect(weekly?.weeklyBurnVolume).toBe(2000000n);
    expect(weekly?.weeklyBurnCount).toBe(1);
  });
});

describe("Unit: Approval handler", () => {
  it("Creates approval and ensures both accounts exist", async () => {
    const mockDb = MockDb.createMockDb();
    const owner = Addresses.mockAddresses[0]!;
    const spender = Addresses.mockAddresses[1]!;

    const mockApproval = ERC20.Approval.createMockEvent({
      owner,
      spender,
      value: 1000000n,
      mockEventData: { srcAddress: USDC_ADDRESS, chainId: MOCK_CHAIN_ID },
    });

    const result = await ERC20.Approval.processEvent({
      event: mockApproval,
      mockDb,
    });

    const approvalId = `${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${owner}-${spender}`;
    const approval = result.entities.Approval.get(approvalId);
    expect(approval).toBeDefined();
    expect(approval?.amount).toBe(1000000n);
    expect(approval?.token).toBe(USDC_ADDRESS);

    expect(
      result.entities.Account.get(`${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${owner}`)
    ).toBeDefined();
    expect(
      result.entities.Account.get(`${MOCK_CHAIN_ID}-${USDC_ADDRESS}-${spender}`)
    ).toBeDefined();
  });
});
