import { NextResponse } from "next/server";
import { ethers } from "ethers";

// --------- Config ---------

// Linea RPC – can be overridden in Vercel env with LINEA_RPC_URL
const RPC_URL = process.env.LINEA_RPC_URL || "https://rpc.linea.build";

// Contracts
const BUY_CONTRACT_ADDRESS = "0x0E153774004835dcf78d7F8AE32bD00cF1743A7a";
const CLAIM_CONTRACT_ADDRESS = "0xea84Ff406e2d4cF61015BD7BBc313050Ff1BD81d";

// If you know deploy blocks you can set them here to speed up.
// 0 is safe because we filter by address+topic.
const BUY_DEPLOY_BLOCK = 0;
const CLAIM_DEPLOY_BLOCK = 0;

// How many blocks per chunk (to avoid 10k logs limit)
const CHUNK_SIZE_BLOCKS = 200_000;

// $ value per buy used for bonus calculation
const PRICE_PER_BUY_USD = 0.1;

// Buy ABI: real event + bonusPercent() view
// event Buy(address indexed user, uint256 ethPaid, uint64 userTotalBuys, uint32 buysInCurrentWindow)
// function bonusPercent(address user) view returns (uint16)
const BUY_ABI = [
  "event Buy(address indexed user, uint256 ethPaid, uint64 userTotalBuys, uint32 buysInCurrentWindow)",
  "function bonusPercent(address user) view returns (uint16)",
];

// ✅ Correct Claim ABI from LineaScan:
// Claim (index_topic_1 address user, uint256 allocationsClaimed, uint256 tokensPaid)
const CLAIM_ABI = [
  "event Claim(address indexed user, uint256 allocationsClaimed, uint256 tokensPaid)",
];

type SummaryRow = {
  wallet: string;
  totalBuys: number;
  totalClaims: number; // sum of allocationsClaimed
  bonusPercent: number;
  bonusValueUsd: number;
};

// Helper to call JSON-RPC directly with fetch
async function callRpc(method: string, params: any[]): Promise<any> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });

  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `RPC HTTP ${res.status} for ${method} – body: ${text || "<empty>"}`
    );
  }

  let json: any;
  try {
    json = await res.json();
  } catch (e: any) {
    throw new Error(`RPC ${method} invalid JSON response: ${e?.message || e}`);
  }

  if (json.error) {
    throw new Error(
      `RPC ${method} error: ${
        json.error.message || JSON.stringify(json.error)
      }`
    );
  }

  return json.result;
}

export async function GET() {
  try {
    const buyIface = new ethers.utils.Interface(BUY_ABI);
    const claimIface = new ethers.utils.Interface(CLAIM_ABI);

    const buyTopic = buyIface.getEventTopic("Buy");
    const claimTopic = claimIface.getEventTopic("Claim");

    // 1) Get latest block number
    const latestBlockHex: string = await callRpc("eth_blockNumber", []);
    const latestBlock = parseInt(latestBlockHex, 16);
    if (Number.isNaN(latestBlock)) {
      throw new Error(
        `Could not parse latest block number from result: ${latestBlockHex}`
      );
    }

    // 2) Accumulate per-wallet totalBuys
    const userStats = new Map<
      string,
      { totalBuys: number; totalClaims: number; bonusPercent: number }
    >();

    for (
      let fromBlock = BUY_DEPLOY_BLOCK;
      fromBlock <= latestBlock;
      fromBlock += CHUNK_SIZE_BLOCKS + 1
    ) {
      const toBlock = Math.min(fromBlock + CHUNK_SIZE_BLOCKS, latestBlock);
      const fromHex = "0x" + fromBlock.toString(16);
      const toHex = "0x" + toBlock.toString(16);

      const filter = {
        address: BUY_CONTRACT_ADDRESS,
        fromBlock: fromHex,
        toBlock: toHex,
        topics: [buyTopic],
      };

      const logs: any[] = await callRpc("eth_getLogs", [filter]);

      for (const log of logs) {
        const parsed = buyIface.parseLog({
          topics: log.topics,
          data: log.data,
        });

        const user: string = (parsed.args.user as string).toLowerCase();
        const userTotalBuysBn = parsed.args
          .userTotalBuys as ethers.BigNumber;
        const totalBuys = userTotalBuysBn.toNumber();

        const existing = userStats.get(user);
        if (!existing || totalBuys > existing.totalBuys) {
          userStats.set(user, {
            totalBuys,
            totalClaims: existing?.totalClaims ?? 0,
            bonusPercent: existing?.bonusPercent ?? 0,
          });
        }
      }
    }

    // 3) Accumulate per-wallet totalClaims from Claim events
    // Here we interpret "totalClaims" as the SUM of allocationsClaimed.
    for (
      let fromBlock = CLAIM_DEPLOY_BLOCK;
      fromBlock <= latestBlock;
      fromBlock += CHUNK_SIZE_BLOCKS + 1
    ) {
      const toBlock = Math.min(fromBlock + CHUNK_SIZE_BLOCKS, latestBlock);
      const fromHex = "0x" + fromBlock.toString(16);
      const toHex = "0x" + toBlock.toString(16);

      const filter = {
        address: CLAIM_CONTRACT_ADDRESS,
        fromBlock: fromHex,
        toBlock: toHex,
        topics: [claimTopic],
      };

      const logs: any[] = await callRpc("eth_getLogs", [filter]);

      for (const log of logs) {
        const parsed = claimIface.parseLog({
          topics: log.topics,
          data: log.data,
        });

        const user: string = (parsed.args.user as string).toLowerCase();
        const allocationsBn = parsed.args
          .allocationsClaimed as ethers.BigNumber;
        const allocations = allocationsBn.toNumber();

        const existing = userStats.get(user) || {
          totalBuys: 0,
          totalClaims: 0,
          bonusPercent: 0,
        };

        // allocationsClaimed is per-tx, so we SUM it.
        existing.totalClaims += allocations;

        userStats.set(user, existing);
      }
    }

    // 4) Fetch bonusPercent for each wallet from Buy contract
    for (const [wallet, stats] of userStats.entries()) {
      try {
        const data = buyIface.encodeFunctionData("bonusPercent", [wallet]);
        const resultHex: string = await callRpc("eth_call", [
          { to: BUY_CONTRACT_ADDRESS, data },
          "latest",
        ]);

        const bp = ethers.BigNumber.from(resultHex).toNumber();
        stats.bonusPercent = bp;
        userStats.set(wallet, stats);
      } catch (e) {
        console.error(
          `Failed to fetch bonusPercent for wallet ${wallet}:`,
          e
        );
      }
    }

    // 5) Build final rows: buys, claims, full bonus
    const rows: SummaryRow[] = [];

    for (const [wallet, { totalBuys, totalClaims, bonusPercent }] of userStats.entries()) {
      if (totalBuys === 0 && totalClaims === 0) continue;

      const base = totalBuys * PRICE_PER_BUY_USD;
      const bonusValueUsd = base * (1 + bonusPercent / 100);

      rows.push({
        wallet,
        totalBuys,
        totalClaims, // sum of allocationsClaimed
        bonusPercent,
        bonusValueUsd,
      });
    }

    // Sort by totalBuys desc, then bonusPercent desc
    rows.sort((a, b) => {
      if (b.totalBuys !== a.totalBuys) return b.totalBuys - a.totalBuys;
      return b.bonusPercent - a.bonusPercent;
    });

    return NextResponse.json({ rows }, { status: 200 });
  } catch (err: any) {
    console.error("Final summary API error:", err);
    return NextResponse.json(
      {
        error: "Failed to build final summary",
        details: err?.message || String(err),
      },
      { status: 500 }
    );
  }
}
