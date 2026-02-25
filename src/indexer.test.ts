import { describe, it, expect } from "vitest";
import { TestHelpers, createTestIndexer, type Account } from "generated";
import "./handlers/ERC20.js";

const { MockDb, ERC20, Addresses } = TestHelpers;

// Integration tests require network access to HyperSync.
// Run with: INTEGRATION=1 pnpm test
describe.runIf(process.env.INTEGRATION)(
  "Integration: Arbitrum USDC transfers",
  () => {
    it(
      "Should process transfers and create correct entities",
      async () => {
        const indexer = createTestIndexer();

        const result = await indexer.process({
          chains: {
            42161: {
              startBlock: 250_000_000,
              endBlock: 250_001_000,
            },
          },
        });

        // Verify we got some changes back
        expect(result.changes.length).toBeGreaterThan(0);

        // Check that Transfer entities were created
        const firstChange = result.changes[0]!;
        const transfers = firstChange.Transfer?.sets;
        if (transfers) {
          expect(transfers.length).toBeGreaterThan(0);
          expect(transfers[0]!.chainId).toBe(42161);
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

    // Set initial state with chainId-prefixed account
    const mockAccountEntity: Account = {
      id: `42161-${userAddress1}`,
      chainId: 42161,
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
    });

    const mockDbAfterTransfer = await ERC20.Transfer.processEvent({
      event: mockTransfer,
      mockDb,
    });

    // Check sender balance decreased
    const senderAccount = mockDbAfterTransfer.entities.Account.get(
      `${mockTransfer.chainId}-${userAddress1}`
    );
    expect(senderAccount?.balance).toBe(5000000n - 3000000n);
    expect(senderAccount?.transfersOut).toBe(1);

    // Check receiver account created with correct balance
    const receiverAccount = mockDbAfterTransfer.entities.Account.get(
      `${mockTransfer.chainId}-${userAddress2}`
    );
    expect(receiverAccount?.balance).toBe(3000000n);
    expect(receiverAccount?.transfersIn).toBe(1);

    // Check Transfer entity was created
    const transferId = `${mockTransfer.chainId}_${mockTransfer.block.number}_${mockTransfer.logIndex}`;
    const transferEntity = mockDbAfterTransfer.entities.Transfer.get(transferId);
    expect(transferEntity).toBeDefined();
    expect(transferEntity?.transferType).toBe("TRANSFER");
    expect(transferEntity?.value).toBe(3000000n);

    // Check ChainSupply was created
    const supply = mockDbAfterTransfer.entities.ChainSupply.get(
      `${mockTransfer.chainId}-supply`
    );
    expect(supply).toBeDefined();
    expect(supply?.transferCount).toBe(1);

    // Check DailySnapshot was created
    const dayId = Math.floor(mockTransfer.block.timestamp / 86400);
    const snapshot = mockDbAfterTransfer.entities.DailySnapshot.get(
      `${mockTransfer.chainId}-${dayId}`
    );
    expect(snapshot).toBeDefined();
    expect(snapshot?.dailyTransferCount).toBe(1);
    expect(snapshot?.dailyVolume).toBe(3000000n);
  });

  it("Mint (from zero address) increases supply and skips sender update", async () => {
    const mockDb = MockDb.createMockDb();
    const receiver = Addresses.mockAddresses[0]!;
    const zeroAddress = "0x0000000000000000000000000000000000000000";

    const mockMint = ERC20.Transfer.createMockEvent({
      from: zeroAddress,
      to: receiver,
      value: 1000000n,
    });

    const result = await ERC20.Transfer.processEvent({
      event: mockMint,
      mockDb,
    });

    // Transfer should be typed as MINT
    const transferId = `${mockMint.chainId}_${mockMint.block.number}_${mockMint.logIndex}`;
    const transfer = result.entities.Transfer.get(transferId);
    expect(transfer?.transferType).toBe("MINT");

    // No sender account should be created for zero address
    const zeroAccount = result.entities.Account.get(
      `${mockMint.chainId}-${zeroAddress}`
    );
    expect(zeroAccount).toBeUndefined();

    // Receiver should have the minted amount
    const receiverAccount = result.entities.Account.get(
      `${mockMint.chainId}-${receiver}`
    );
    expect(receiverAccount?.balance).toBe(1000000n);

    // ChainSupply should reflect the mint
    const supply = result.entities.ChainSupply.get(
      `${mockMint.chainId}-supply`
    );
    expect(supply?.totalSupply).toBe(1000000n);
    expect(supply?.totalMinted).toBe(1000000n);
    expect(supply?.mintCount).toBe(1);
  });

  it("Burn (to zero address) decreases supply and skips receiver update", async () => {
    const mockDbEmpty = MockDb.createMockDb();
    const sender = Addresses.mockAddresses[0]!;
    const zeroAddress = "0x0000000000000000000000000000000000000000";

    // Pre-populate sender with a balance
    const mockDb = mockDbEmpty.entities.Account.set({
      id: `42161-${sender}`,
      chainId: 42161,
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
    });

    const result = await ERC20.Transfer.processEvent({
      event: mockBurn,
      mockDb,
    });

    // Transfer should be typed as BURN
    const transferId = `${mockBurn.chainId}_${mockBurn.block.number}_${mockBurn.logIndex}`;
    const transfer = result.entities.Transfer.get(transferId);
    expect(transfer?.transferType).toBe("BURN");

    // No receiver account should be created for zero address
    const zeroAccount = result.entities.Account.get(
      `${mockBurn.chainId}-${zeroAddress}`
    );
    expect(zeroAccount).toBeUndefined();

    // Sender balance should decrease
    const senderAccount = result.entities.Account.get(
      `${mockBurn.chainId}-${sender}`
    );
    expect(senderAccount?.balance).toBe(3000000n);

    // ChainSupply should reflect the burn
    const supply = result.entities.ChainSupply.get(
      `${mockBurn.chainId}-supply`
    );
    expect(supply?.totalBurned).toBe(2000000n);
    expect(supply?.burnCount).toBe(1);
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
    });

    const result = await ERC20.Approval.processEvent({
      event: mockApproval,
      mockDb,
    });

    // Approval entity should exist
    const approvalId = `${mockApproval.chainId}-${owner}-${spender}`;
    const approval = result.entities.Approval.get(approvalId);
    expect(approval).toBeDefined();
    expect(approval?.amount).toBe(1000000n);

    // Both accounts should exist
    const ownerAccount = result.entities.Account.get(
      `${mockApproval.chainId}-${owner}`
    );
    expect(ownerAccount).toBeDefined();
    expect(ownerAccount?.balance).toBe(0n);

    const spenderAccount = result.entities.Account.get(
      `${mockApproval.chainId}-${spender}`
    );
    expect(spenderAccount).toBeDefined();
  });
});
