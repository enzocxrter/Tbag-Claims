"use client";

import React, { useEffect, useState } from "react";
import Head from "next/head";
import { ethers } from "ethers";

// -----------------------------
// Constants
// -----------------------------

// Linea MAINNET DoubleBagzV2 BUY contract
const BUY_CONTRACT_ADDRESS =
  "0x0E153774004835dcf78d7F8AE32bD00cF1743A7a";

// Linea MAINNET DoubleBagzClaimsTBAG contract
const CLAIM_CONTRACT_ADDRESS =
  "0xea84Ff406e2d4cF61015BD7BBc313050Ff1BD81d";

// Assume TBAG has 18 decimals (standard)
const TBAG_DECIMALS = 18;

// Buy contract ABI (DoubleBagzV2)
const BUY_CONTRACT_ABI = [
  "function ethPerBuy() view returns (uint256)",
  "function maxBuysPerDay() view returns (uint8)",
  "function maxBonusPercent() view returns (uint16)",
  "function totalBuysGlobal() view returns (uint256)",
  "function totalBuys(address user) view returns (uint64)",
  "function bonusPercent(address user) view returns (uint16)",
  "function remainingBuysToday(address user) view returns (uint256)",
  "function buy(bytes pohSignature) payable",
];

// Claims contract ABI (DoubleBagzClaimsTBAG)
const CLAIM_CONTRACT_ABI = [
  "function tbagPerAllocation() view returns (uint256)",
  "function claimable(address user) view returns (uint256)",
  "function claimed(address user) view returns (uint256)",
  "function claimableTbagWithBonus(address user) view returns (uint256)",
  "function claim(uint256 allocations)",
  "function bonusPercent(address user) view returns (uint16)",
  "function totalBuysGlobal() view returns (uint256)",
];

// Linea PoH APIs
const POH_API_BASE = "https://poh-api.linea.build/poh/v2";
const POH_SIGNER_API_BASE = "https://poh-signer-api.linea.build/poh/v2";
const POH_PORTAL_URL =
  "https://linea.build/hub/apps/sumsub-reusable-identity";

// TypeScript: allow window.ethereum
declare global {
  interface Window {
    ethereum?: any;
  }
}

type LeaderboardRow = {
  wallet: string;
  totalBuys: number;
  bonusPercent: number;
  bonusValueUsd: number;
};

export default function Home() {
  // -----------------------------
  // Wallet / Network state
  // -----------------------------
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [autoConnectEnabled, setAutoConnectEnabled] = useState<boolean>(true);

  // -----------------------------
  // Buy contract data (DoubleBagzV2)
  // -----------------------------
  const [ethPerBuy, setEthPerBuy] = useState<ethers.BigNumber | null>(null);
  const [maxBuysPerDay, setMaxBuysPerDay] = useState<number>(0);
  const [maxBonusPercent, setMaxBonusPercent] = useState<number>(0);
  const [totalBuysGlobal, setTotalBuysGlobal] = useState<number>(0);
  const [yourTotalBuys, setYourTotalBuys] = useState<number>(0);
  const [remainingBuysToday, setRemainingBuysToday] = useState<number | null>(
    null
  );
  const [bonusPercent, setBonusPercent] = useState<number>(0);

  // -----------------------------
  // Claim contract data (DoubleBagzClaimsTBAG)
  // -----------------------------
  const [tbagPerAllocation, setTbagPerAllocation] =
    useState<ethers.BigNumber | null>(null);
  const [claimableAllocations, setClaimableAllocations] = useState<
    number | null
  >(null);
  const [claimedAllocations, setClaimedAllocations] = useState<
    number | null
  >(null);
  const [claimableTbagWithBonus, setClaimableTbagWithBonus] = useState<
    ethers.BigNumber | null
  >(null);

  // -----------------------------
  // UI state
  // -----------------------------
  const [activeTab, setActiveTab] = useState<"buy" | "claim">("buy");
  const [isLoadingData, setIsLoadingData] = useState<boolean>(false);
  const [isBuying, setIsBuying] = useState<boolean>(false);
  const [isClaiming, setIsClaiming] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);
  const [showWelcomeModal, setShowWelcomeModal] = useState<boolean>(true);

  // PoH (Linea API) state
  const [isPohVerified, setIsPohVerified] = useState<boolean | null>(null);
  const [isCheckingPoh, setIsCheckingPoh] = useState<boolean>(false);

  // Leaderboard state
  const [leaderboardRows, setLeaderboardRows] = useState<LeaderboardRow[]>([]);
  const [isLoadingLeaderboard, setIsLoadingLeaderboard] =
    useState<boolean>(false);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);

  // -----------------------------
  // Chain ID helpers
  // -----------------------------
  let numericChainId: number | null = null;
  if (chainId) {
    if (chainId.startsWith("0x") || chainId.startsWith("0X")) {
      numericChainId = parseInt(chainId, 16);
    } else {
      numericChainId = parseInt(chainId, 10);
    }
  }

  const LINEA_MAINNET_CHAIN_ID = 59144;
  const isOnLineaMainnet = numericChainId === LINEA_MAINNET_CHAIN_ID;

  // -----------------------------
  // PoH check via Linea API (for UX)
  // -----------------------------
  const checkPohStatus = async (address: string) => {
    try {
      setIsCheckingPoh(true);
      setIsPohVerified(null);

      const res = await fetch(`${POH_API_BASE}/${address}`);
      if (!res.ok) {
        throw new Error(`PoH HTTP ${res.status}`);
      }

      const text = (await res.text()).trim(); // "true" or "false"
      const isHuman = text === "true";
      setIsPohVerified(isHuman);
    } catch (err) {
      console.error("PoH check failed:", err);
      setIsPohVerified(null);
      setErrorMessage((prev) => prev ?? "Could not check Proof of Humanity.");
    } finally {
      setIsCheckingPoh(false);
    }
  };

  // -----------------------------
  // Load contract data (Buy + Claim)
  // -----------------------------
  const loadContractData = async (address?: string | null) => {
    try {
      setIsLoadingData(true);
      setErrorMessage(null);

      if (typeof window === "undefined" || !window.ethereum) return;

      const provider = new ethers.providers.Web3Provider(window.ethereum);

      const buyContract = new ethers.Contract(
        BUY_CONTRACT_ADDRESS,
        BUY_CONTRACT_ABI,
        provider
      );

      const claimContract = CLAIM_CONTRACT_ADDRESS
        ? new ethers.Contract(
            CLAIM_CONTRACT_ADDRESS,
            CLAIM_CONTRACT_ABI,
            provider
          )
        : null;

      // Global buy data
      const [ethPerBuyBn, maxBuysPerDayBn, maxBonusBn, totalGlobalBn] =
        await Promise.all([
          buyContract.ethPerBuy(),
          buyContract.maxBuysPerDay(),
          buyContract.maxBonusPercent(),
          buyContract.totalBuysGlobal(),
        ]);

      setEthPerBuy(ethPerBuyBn);
      setMaxBuysPerDay(Number(maxBuysPerDayBn));
      setMaxBonusPercent(Number(maxBonusBn));
      setTotalBuysGlobal(totalGlobalBn.toNumber());

      // Global claim data
      if (claimContract) {
        const tbagPerAllocBn = await claimContract.tbagPerAllocation();
        setTbagPerAllocation(tbagPerAllocBn);
      } else {
        setTbagPerAllocation(null);
      }

      // Per-wallet data
      if (address) {
        const [userTotalBuysBn, bonusPercentBn, remainingBn] =
          await Promise.all([
            buyContract.totalBuys(address),
            buyContract.bonusPercent(address),
            buyContract.remainingBuysToday(address),
          ]);

        setYourTotalBuys(Number(userTotalBuysBn));
        setBonusPercent(Number(bonusPercentBn));
        setRemainingBuysToday(remainingBn.toNumber());

        if (claimContract) {
          const [claimableAllocBn, claimedAllocBn, claimableTbagWithBonusBn] =
            await Promise.all([
              claimContract.claimable(address),
              claimContract.claimed(address),
              claimContract.claimableTbagWithBonus(address),
            ]);

          setClaimableAllocations(claimableAllocBn.toNumber());
          setClaimedAllocations(claimedAllocBn.toNumber());
          setClaimableTbagWithBonus(claimableTbagWithBonusBn);
        } else {
          setClaimableAllocations(null);
          setClaimedAllocations(null);
          setClaimableTbagWithBonus(null);
        }
      } else {
        setYourTotalBuys(0);
        setBonusPercent(0);
        setRemainingBuysToday(null);
        setClaimableAllocations(null);
        setClaimedAllocations(null);
        setClaimableTbagWithBonus(null);
      }
    } catch (err) {
      console.error("Error loading contract data:", err);
      setErrorMessage(
        "Error loading contract data. Check network & contract addresses."
      );
    } finally {
      setIsLoadingData(false);
    }
  };

  // -----------------------------
  // Connect / Disconnect wallet
  // -----------------------------
  const connectWallet = async () => {
    try {
      setErrorMessage(null);
      setSuccessMessage(null);

      if (typeof window === "undefined" || !window.ethereum) {
        setErrorMessage("MetaMask not found. Please install it to continue.");
        return;
      }

      const accounts = await window.ethereum.request({
        method: "eth_requestAccounts",
      });

      const selected = accounts[0];
      setWalletAddress(selected);

      const cid = await window.ethereum.request({ method: "eth_chainId" });
      setChainId(cid);

      setAutoConnectEnabled(true);

      await Promise.all([
        loadContractData(selected),
        checkPohStatus(selected),
      ]);
    } catch (err) {
      console.error("Error connecting wallet:", err);
      setErrorMessage("Failed to connect wallet.");
    }
  };

  const disconnectWallet = () => {
    setWalletAddress(null);
    setChainId(null);
    setYourTotalBuys(0);
    setRemainingBuysToday(null);
    setBonusPercent(0);
    setIsPohVerified(null);
    setIsCheckingPoh(false);
    setClaimableAllocations(null);
    setClaimedAllocations(null);
    setClaimableTbagWithBonus(null);
    setErrorMessage(null);
    setSuccessMessage(null);
    setAutoConnectEnabled(false);
  };

  // -----------------------------
  // Switch to Linea mainnet
  // -----------------------------
  const switchToLineaMainnet = async () => {
    if (typeof window === "undefined" || !window.ethereum) {
      setErrorMessage("MetaMask not found.");
      return;
    }

    try {
      setErrorMessage(null);
      setSuccessMessage(null);

      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0xe708" }], // 59144 in hex
      });

      const cid = await window.ethereum.request({ method: "eth_chainId" });
      setChainId(cid);

      if (walletAddress) {
        await Promise.all([
          loadContractData(walletAddress),
          checkPohStatus(walletAddress),
        ]);
      }

      setSuccessMessage("Switched to Linea mainnet.");
    } catch (switchError: any) {
      console.error("Error switching network:", switchError);

      if (switchError?.code === 4902) {
        // Add Linea mainnet if not present
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: "0xe708",
                chainName: "Linea",
                nativeCurrency: {
                  name: "Linea ETH",
                  symbol: "ETH",
                  decimals: 18,
                },
                rpcUrls: ["https://rpc.linea.build"],
                blockExplorerUrls: ["https://lineascan.build"],
              },
            ],
          });

          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0xe708" }],
          });

          const cid = await window.ethereum.request({
            method: "eth_chainId",
          });
          setChainId(cid);

          if (walletAddress) {
            await Promise.all([
              loadContractData(walletAddress),
              checkPohStatus(walletAddress),
            ]);
          }

          setSuccessMessage("Linea network added and selected in your wallet.");
        } catch (addError) {
          console.error("Error adding Linea:", addError);
          setErrorMessage(
            "Failed to add Linea network. Please add it manually."
          );
        }
      } else if (switchError?.code === 4001) {
        setErrorMessage("Network switch was rejected in your wallet.");
      } else {
        setErrorMessage("Failed to switch network in MetaMask.");
      }
    }
  };

  // -----------------------------
  // Buy flow
  // -----------------------------
  const executeBuyTx = async () => {
    try {
      setErrorMessage(null);
      setSuccessMessage(null);

      if (typeof window === "undefined" || !window.ethereum) {
        setErrorMessage("MetaMask not found.");
        return;
      }
      if (!walletAddress) {
        setErrorMessage("Connect your wallet first.");
        return;
      }
      if (!isOnLineaMainnet) {
        setErrorMessage("Please switch your wallet network to Linea.");
        return;
      }
      if (!ethPerBuy) {
        setErrorMessage(
          "ETH price per buy is still loading. Please wait a second and try again."
        );
        return;
      }
      if (ethPerBuy.isZero()) {
        setErrorMessage(
          "ETH price per buy is set to 0 on the contract. The owner must call setEthPerBuy()."
        );
        return;
      }

      // PoH UX check (Linea API)
      if (isPohVerified === false) {
        setErrorMessage(
          "This wallet is not Proof-of-Humanity verified via Linea. Complete PoH first."
        );
        return;
      }
      if (isPohVerified === null) {
        setErrorMessage(
          "Still checking your PoH status. Please wait a moment and try again."
        );
        return;
      }

      setIsBuying(true);

      const provider = new ethers.providers.Web3Provider(window.ethereum);
      const signer = provider.getSigner();
      const buyContract = new ethers.Contract(
        BUY_CONTRACT_ADDRESS,
        BUY_CONTRACT_ABI,
        signer
      );

      // Get PoH signature from Linea signer API
      const sigRes = await fetch(`${POH_SIGNER_API_BASE}/${walletAddress}`);
      if (!sigRes.ok) {
        throw new Error(`PoH signer HTTP ${sigRes.status}`);
      }
      const rawSig = (await sigRes.text()).trim();
      if (!rawSig || !rawSig.startsWith("0x")) {
        throw new Error("Invalid PoH signature format");
      }
      const pohSignature = rawSig;

      // Pre-check balance (value only, gas not included)
      const balance = await provider.getBalance(walletAddress);
      if (balance.lt(ethPerBuy)) {
        setErrorMessage("You need more ETH for this buy.");
        setIsBuying(false);
        return;
      }

      const tx = await buyContract.buy(pohSignature, {
        value: ethPerBuy,
      });

      await tx.wait();

      setSuccessMessage("Buy successful!");
      setShowConfirmModal(false);

      // Reload stats
      await loadContractData(walletAddress);
    } catch (err: any) {
      console.error("Buy error:", err);

      const rawMsg =
        err?.error?.message ||
        err?.data?.message ||
        err?.reason ||
        err?.message ||
        String(err ?? "");
      const lower = rawMsg.toLowerCase();

      if (err?.code === "ACTION_REJECTED" || lower.includes("user rejected")) {
        setErrorMessage("Transaction rejected in wallet.");
      } else if (lower.includes("notpohverified")) {
        setErrorMessage(
          "This wallet is not PoH-verified according to Linea's on-chain verifier."
        );
      } else if (lower.includes("not poh verified")) {
        setErrorMessage(
          "This wallet is not PoH-verified according to Linea's on-chain verifier."
        );
      } else if (lower.includes("poh") && lower.includes("verify")) {
        setErrorMessage(
          "PoH verification failed. Make sure you completed PoH with this wallet."
        );
      } else if (lower.includes("ethperbuynotset")) {
        setErrorMessage("ETH per buy is not configured on the contract.");
      } else if (lower.includes("wrongethamount")) {
        setErrorMessage(
          "Incorrect ETH amount sent. Refresh the page and try again."
        );
      } else if (lower.includes("dailylimitreached")) {
        setErrorMessage("Daily buy limit reached. Try again in the next 24h.");
      } else if (
        lower.includes("insufficient funds") ||
        lower.includes("insufficient eth")
      ) {
        setErrorMessage("You need more ETH for this buy + gas.");
      } else if (lower.includes("signer http")) {
        setErrorMessage(
          "Could not fetch PoH signature from Linea. Please try again in a moment."
        );
      } else if (lower.includes("invalid poh signature format")) {
        setErrorMessage(
          "Received invalid PoH signature format. Please try again."
        );
      } else {
        setErrorMessage("Buy transaction failed. Check console for details.");
      }
    } finally {
      setIsBuying(false);
    }
  };

  // Primary CTA handler for Buy tab
  const handlePrimaryAction = async () => {
    if (!walletAddress) {
      await connectWallet();
      return;
    }

    if (!isOnLineaMainnet) {
      await switchToLineaMainnet();
      return;
    }

    // If PoH says NOT verified (via API), send them to the PoH portal
    if (isPohVerified === false) {
      window.open(POH_PORTAL_URL, "_blank");
      return;
    }

    // Otherwise open the confirm modal
    setShowConfirmModal(true);
  };

  // -----------------------------
  // Claim flow
  // -----------------------------
  const handleClaim = async () => {
    try {
      setErrorMessage(null);
      setSuccessMessage(null);

      if (typeof window === "undefined" || !window.ethereum) {
        setErrorMessage("MetaMask not found.");
        return;
      }
      if (!walletAddress) {
        setErrorMessage("Connect your wallet first.");
        return;
      }
      if (!isOnLineaMainnet) {
        setErrorMessage("Please switch your wallet network to Linea.");
        return;
      }
      if (!CLAIM_CONTRACT_ADDRESS) {
        setErrorMessage("Claim contract is not configured.");
        return;
      }

      setIsClaiming(true);

      const provider = new ethers.providers.Web3Provider(window.ethereum);
      const signer = provider.getSigner();
      const claimContract = new ethers.Contract(
        CLAIM_CONTRACT_ADDRESS,
        CLAIM_CONTRACT_ABI,
        signer
      );

      const available: ethers.BigNumber = await claimContract.claimable(
        walletAddress
      );

      if (available.eq(0)) {
        setErrorMessage("No claimable TBAG allocations for this wallet.");
        setIsClaiming(false);
        return;
      }

      // Claim 1 allocation per tx (for more tx count)
      const tx = await claimContract.claim(1);
      await tx.wait();

      setSuccessMessage("Claim successful!");

      await loadContractData(walletAddress);
    } catch (err: any) {
      console.error("Claim error:", err);

      const rawMsg =
        err?.error?.message ||
        err?.data?.message ||
        err?.reason ||
        err?.message ||
        String(err ?? "");
      const lower = rawMsg.toLowerCase();

      if (err?.code === "ACTION_REJECTED" || lower.includes("user rejected")) {
        setErrorMessage("Claim transaction rejected in wallet.");
      } else if (lower.includes("noallocationstoclaim")) {
        setErrorMessage("No claimable TBAG allocations for this wallet.");
      } else if (lower.includes("notenoughclaimable")) {
        setErrorMessage("Not enough claimable allocations for this request.");
      } else if (lower.includes("tbagperallocationnotset")) {
        setErrorMessage(
          "tbagPerAllocation is not configured on the claim contract."
        );
      } else if (
        lower.includes("insufficientrewardbalance") ||
        lower.includes("insufficient balance")
      ) {
        setErrorMessage(
          "Claim contract does not have enough TBAG to pay this claim."
        );
      } else if (lower.includes("transferfailed")) {
        setErrorMessage(
          "TBAG transfer failed from claim contract. Check token balance."
        );
      } else {
        setErrorMessage("Claim transaction failed. Check console for details.");
      }
    } finally {
      setIsClaiming(false);
    }
  };

  // -----------------------------
  // Auto-connect & event listeners
  // -----------------------------
  useEffect(() => {
    if (typeof window === "undefined" || !window.ethereum) return;

    const handleAccountsChanged = (accounts: string[]) => {
      if (accounts.length === 0) {
        setWalletAddress(null);
        setYourTotalBuys(0);
        setRemainingBuysToday(null);
        setBonusPercent(0);
        setIsPohVerified(null);
        setClaimableAllocations(null);
        setClaimedAllocations(null);
        setClaimableTbagWithBonus(null);
      } else {
        const acc = accounts[0];
        setWalletAddress(acc);
        loadContractData(acc).catch(console.error);
        checkPohStatus(acc).catch(console.error);
      }
    };

    const handleChainChanged = (cid: string) => {
      setChainId(cid);
      if (walletAddress) {
        loadContractData(walletAddress).catch(console.error);
        checkPohStatus(walletAddress).catch(console.error);
      }
    };

    if (autoConnectEnabled) {
      window.ethereum
        .request({ method: "eth_accounts" })
        .then((accounts: string[]) => {
          if (accounts.length > 0) {
            const acc = accounts[0];
            setWalletAddress(acc);
            loadContractData(acc).catch(console.error);
            checkPohStatus(acc).catch(console.error);
          }
        })
        .catch(console.error);
    }

    window.ethereum
      .request({ method: "eth_chainId" })
      .then((cid: string) => {
        setChainId(cid);
      })
      .catch(console.error);

    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);

    return () => {
      if (!window.ethereum) return;
      window.ethereum.removeListener("accountsChanged", handleAccountsChanged);
      window.ethereum.removeListener("chainChanged", handleChainChanged);
    };
  }, [walletAddress, autoConnectEnabled]);

  // -----------------------------
  // Fetch leaderboard from API
  // -----------------------------
  useEffect(() => {
    const fetchLeaderboard = async () => {
      try {
        setIsLoadingLeaderboard(true);
        setLeaderboardError(null);

        const res = await fetch("/api/leaderboard");
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `HTTP ${res.status}`);
        }

        const data = await res.json();
        const rows: LeaderboardRow[] = data.rows || [];
        setLeaderboardRows(rows);
      } catch (err: any) {
        console.error("Fetch leaderboard error:", err);
        setLeaderboardError("Could not load leaderboard.");
      } finally {
        setIsLoadingLeaderboard(false);
      }
    };

    fetchLeaderboard();
  }, []);

  // -----------------------------
  // Derived values / labels
  // -----------------------------
  const formattedEthPerBuy = ethPerBuy
    ? ethers.utils.formatEther(ethPerBuy)
    : "---";

  const formattedClaimableTbagWithBonus = claimableTbagWithBonus
    ? ethers.utils.formatUnits(claimableTbagWithBonus, TBAG_DECIMALS)
    : "0";

  const exportLeaderboardCsv = () => {
    if (leaderboardRows.length === 0) return;

    const headers = [
      "Rank",
      "Wallet",
      "Total Buys",
      "Bonus Percent",
      "Bonus Value USD",
    ];

    const escapeCsvValue = (value: string | number) =>
      `"${String(value).replace(/"/g, '""')}"`;

    const rows = leaderboardRows.map((row, index) => [
      index + 1,
      row.wallet,
      row.totalBuys,
      row.bonusPercent,
      row.bonusValueUsd.toFixed(2),
    ]);

    const csv = [headers, ...rows]
      .map((row) => row.map(escapeCsvValue).join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `double-bagz-leaderboard-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
  };

  // Base TBAG (without bonus) for all currently claimable allocations
  const baseClaimableTbag =
    tbagPerAllocation && claimableAllocations !== null
      ? tbagPerAllocation.mul(ethers.BigNumber.from(claimableAllocations))
      : null;

  const formattedBaseClaimableTbag = baseClaimableTbag
    ? ethers.utils.formatUnits(baseClaimableTbag, TBAG_DECIMALS)
    : "0";

  // Total post-Exponent value (USD-style) for this wallet: totalBuys * $0.10 * (1 + bonus%)
  const totalPostExponentBonusValueUsd = (() => {
    if (!walletAddress) return 0;
    if (!yourTotalBuys) return 0;
    const base = yourTotalBuys * 0.1; // $0.10 per buy
    const multiplier = 1 + bonusPercent / 100;
    return base * multiplier;
  })();

  const buttonLabel = (() => {
    if (!walletAddress) return "Connect Wallet";
    if (!isOnLineaMainnet) return "Switch to Linea";
    if (isCheckingPoh) return "Checking PoH…";
    if (isPohVerified === false) return "Complete PoH Verification";
    if (isBuying) return "Processing Buy...";
    return "Buy $TBAG Allocation";
  })();

  const isPrimaryDisabled =
    isBuying || isLoadingData || isCheckingPoh || !BUY_CONTRACT_ADDRESS;

  // PoH label
  let pohLabel = "";
  let pohClass = "";

  if (isCheckingPoh) {
    pohLabel = "Checking...";
    pohClass = "checking";
  } else if (isPohVerified === true) {
    pohLabel = "Verified (Linea PoH)";
    pohClass = "ok";
  } else if (walletAddress) {
    pohLabel = "Not verified – required to buy";
    pohClass = "bad";
  }

  // Remaining buys text
  const remainingBuysText = (() => {
    if (!walletAddress) return "-";
    if (maxBuysPerDay === 0) return "Unlimited";
    if (remainingBuysToday === null) return "Loading…";
    return `${remainingBuysToday} / ${maxBuysPerDay}`;
  })();

  // Claim daily limit UX (mirror 10 per 24h)
  const claimDailyLimit = maxBuysPerDay || 10;
  const claimRemainingText = (() => {
    if (!walletAddress) return "-";
    if (claimableAllocations === null) return "Loading…";
    const usableToday = Math.min(claimableAllocations, claimDailyLimit);
    return `${usableToday} / ${claimDailyLimit}`;
  })();

  // Claim button label
  const claimButtonLabel = (() => {
    if (!walletAddress) return "Connect Wallet";
    if (!isOnLineaMainnet) return "Switch to Linea";
    if (isClaiming) return "Claiming...";
    if (claimableAllocations !== null && claimableAllocations === 0)
      return "No Claims Available";
    return "Claim 1 Allocation";
  })();

  const isClaimDisabled =
    isClaiming || isLoadingData || !CLAIM_CONTRACT_ADDRESS;

  // Your rank in leaderboard
  const yourRank = (() => {
    if (!walletAddress || leaderboardRows.length === 0) return null;
    const idx = leaderboardRows.findIndex(
      (row) =>
        row.wallet.toLowerCase() === walletAddress.toLowerCase()
    );
    if (idx === -1) return null;
    return idx + 1;
  })();

  // -----------------------------
  // Render
  // -----------------------------
  return (
    <>
      <Head>
        <title>Double Bagz $TBAG</title>
      </Head>

      <div className="page-root">
        {/* Floating background images */}
        <div className="bg-logo">
          <img src="/LogoTrans.png" alt="$TBAG Logo" />
        </div>
        <div className="bg-img bg-img-1">
          <img src="/TBAG1trans.png" alt="TBAG 1" />
        </div>
        <div className="bg-img bg-img-2">
          <img src="/TBAG2trans.png" alt="TBAG 2" />
        </div>
        <div className="bg-img bg-img-3">
          <img src="/TBAG3trans.png" alt="TBAG 3" />
        </div>
        <div className="bg-img bg-img-4">
          <img src="/TBAG4trans.png" alt="TBAG 4" />
        </div>

        <div className="card-wrapper">
          <div className="mint-card">
            <div className="mint-card-header">
              <h1>Double Bagz</h1>
              <p>Buy $TBAG, get double bag + bonues!</p>
            </div>

            <div className="status-row">
              <span
                className={`status-pill ${isOnLineaMainnet ? "ok" : "bad"}`}
              >
                {isOnLineaMainnet ? "Linea" : "Wrong Network"}
              </span>

              <div className="status-right">
                <span className="status-address">
                  {walletAddress
                    ? `Connected: ${walletAddress.slice(
                        0,
                        6
                      )}...${walletAddress.slice(-4)}`
                    : "Not connected"}
                </span>
                {walletAddress && (
                  <button
                    className="disconnect-btn"
                    type="button"
                    onClick={disconnectWallet}
                  >
                    Disconnect
                  </button>
                )}
                {walletAddress && !isOnLineaMainnet && (
                  <button
                    className="switch-network-btn"
                    type="button"
                    onClick={switchToLineaMainnet}
                  >
                    Switch to Linea
                  </button>
                )}
              </div>
            </div>

            {/* PoH status row */}
            {walletAddress && (
              <div className="poh-row">
                <span className="label">Proof of Humanity</span>
                <span className={`poh-tag ${pohClass}`}>{pohLabel}</span>
              </div>
            )}

            {/* Tabs + Rank pill */}
            <div className="tab-header-row">
              <div className="tab-row">
                <button
                  type="button"
                  className={`tab-btn ${
                    activeTab === "buy" ? "active" : ""
                  }`}
                  onClick={() => setActiveTab("buy")}
                >
                  Buy
                </button>
                <button
                  type="button"
                  className={`tab-btn ${
                    activeTab === "claim" ? "active" : ""
                  }`}
                  onClick={() => setActiveTab("claim")}
                >
                  Claim
                </button>
              </div>
              <div className="rank-pill-wrapper">
                <span className="label">Your Rank</span>
                <span className="rank-pill">
                  {yourRank ? `#${yourRank}` : "--"}
                </span>
              </div>
            </div>

            {/* TAB CONTENT */}
            {activeTab === "buy" && (
              <>
                <div className="info-grid">
                  <div className="info-box">
                    <span className="label">Remaining Buys Today</span>
                    <span className="value">{remainingBuysText}</span>
                  </div>
                  <div className="info-box">
                    <span className="label">Total Buys (Global)</span>
                    <span className="value">
                      {totalBuysGlobal ? totalBuysGlobal.toLocaleString() : 0}
                    </span>
                  </div>
                  <div className="info-box">
                    <span className="label">Your Total Buys</span>
                    <span className="value">
                      {walletAddress ? yourTotalBuys : "-"}
                    </span>
                  </div>
                </div>

                <div className="info-grid info-grid-single">
                  <div className="info-box">
                    <span className="label">Bonus Allocation %</span>
                    <span className="value">
                      {walletAddress ? `${bonusPercent}%` : "-"}
                    </span>
                  </div>
                </div>

                <div className="mint-controls">
                  <div className="cost-row">
                    <span className="label">ETH per buy (target ≈ $0.10)</span>
                    <span className="value">
                      {ethPerBuy ? `${formattedEthPerBuy} ETH` : "---"}
                    </span>
                  </div>

                  <div className="actions-row">
                    <button
                      className="primary-btn"
                      onClick={handlePrimaryAction}
                      disabled={isPrimaryDisabled}
                    >
                      {buttonLabel}
                    </button>
                  </div>
                </div>

                <div className="hint-text">
                  Send $0.10 worth of ETH to claim $0.10 in $TBAG, for each buy
                  you will get another $0.10 of $TBAG + Streak bonuses after
                  Linea Exponent ends
                </div>
              </>
            )}

            {activeTab === "claim" && (
              <div className="claim-tab-content">
                <div className="info-grid info-grid-single">
                  <div className="info-box">
                    <span className="label">Total Claimable Buys</span>
                    <span className="value">
                      {walletAddress
                        ? claimableAllocations !== null
                          ? claimableAllocations
                          : "Loading…"
                        : "-"}
                    </span>
                    <span className="value small">
                      Total amount of $TBAG tokens claimable now (10 claims per
                      24hr)
                    </span>
                  </div>
                </div>

                <div
                  className="info-grid info-grid-single"
                  style={{ marginTop: 10 }}
                >
                  <div className="info-box">
                    <span className="label">Total unclaimable $TBAG</span>
                    <span className="value">
                      {walletAddress
                        ? `$${totalPostExponentBonusValueUsd.toFixed(2)}`
                        : "-"}
                    </span>
                    <span className="value small">
                      Total $TBAG you can claim post Linea Exponent
                    </span>
                  </div>
                </div>

                <div
                  className="info-grid info-grid-single"
                  style={{ marginTop: 10 }}
                >
                  <div className="info-box">
                    <span className="label">Claims Available Today</span>
                    <span className="value">{claimRemainingText}</span>
                  </div>
                </div>

                <div className="mint-controls">
                  <div className="cost-row">
                    <span className="label">
                      $TBAG available to claim (Excluding any bonus $TBAG)
                    </span>
                    <span className="value">
                      {walletAddress
                        ? `${formattedBaseClaimableTbag} TBAG`
                        : "---"}
                    </span>
                  </div>
                  <div className="actions-row">
                    <button
                      className="primary-btn"
                      onClick={handleClaim}
                      disabled={isClaimDisabled}
                    >
                      {claimButtonLabel}
                    </button>
                  </div>
                </div>

                <div className="hint-text">
                  If you claim all now, including your current bonus, you will
                  receive approximately {formattedClaimableTbagWithBonus} TBAG.
                </div>
              </div>
            )}

            {errorMessage && <div className="error-box">{errorMessage}</div>}
            {successMessage && (
              <div className="success-box">{successMessage}</div>
            )}

            {isLoadingData && (
              <div className="hint-text">
                Loading contract data from Linea mainnet…
              </div>
            )}

            {/* Leaderboard */}
            <div className="leaderboard-section">
              <div className="leaderboard-header">
                <div>
                  <span className="label">Leaderboard</span>
                  <span className="value small">
                    Bonus Value = Your Total Buys × $0.10
                  </span>
                </div>
                <button
                  type="button"
                  className="export-csv-btn"
                  onClick={exportLeaderboardCsv}
                  disabled={isLoadingLeaderboard || leaderboardRows.length === 0}
                >
                  Download CSV
                </button>
              </div>

              {isLoadingLeaderboard && (
                <div className="hint-text">Loading leaderboard…</div>
              )}

              {leaderboardError && (
                <div className="error-box">{leaderboardError}</div>
              )}

              {!isLoadingLeaderboard && !leaderboardError && (
                <div className="leaderboard-table-wrapper">
                  <table className="leaderboard-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Wallet</th>
                        <th>Buys</th>
                        <th>Bonus %</th>
                        <th>Bonus Value (USD)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {leaderboardRows.length === 0 && (
                        <tr>
                          <td
                            colSpan={5}
                            style={{ textAlign: "center", padding: "8px" }}
                          >
                            No buys yet.
                          </td>
                        </tr>
                      )}
                      {leaderboardRows.map((row, index) => {
                        const isSelf =
                          walletAddress &&
                          row.wallet.toLowerCase() ===
                            walletAddress.toLowerCase();
                        return (
                          <tr
                            key={row.wallet}
                            className={isSelf ? "self-row" : ""}
                          >
                            <td>{index + 1}</td>
                            <td>
                              {row.wallet.slice(0, 6)}...
                              {row.wallet.slice(-4)}
                            </td>
                            <td>{row.totalBuys}</td>
                            <td>{row.bonusPercent}%</td>
                            <td>${row.bonusValueUsd.toFixed(2)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Welcome modal */}
        {showWelcomeModal && (
  <div className="modal-backdrop">
    <div className="modal-card">
      <h2>Welcome to the T3 Play Double Bagz App</h2>

      <div className="modal-small">
        <p>
          <strong>How to &quot;Double your Bagz&quot;</strong>
        </p>

        <ul>
          <li>
            <strong>Buy:</strong> Spend about $0.10 in ETH per buy, up to 10 buys
            per day.
          </li>
          <li>
            <strong>Earn:</strong> For every $0.10 in ETH, you get about $0.20
            in $TBAG - half claimable now, half claimable after Linea Exponent
            ends.
          </li>
          <li>
            <strong>Bonus:</strong> Max your 10 buys in a day to earn a +1%
            bonus allocation. Example: You max buy (10 buys) on 10 different
            days between now and the end of Linea Exponent, you will get a 10%
            bonus on your $TBAG allocation.
          </li>
        </ul>

        <p>
          All your rewards and bonus are automatically tracked and shown in the
          app.
        </p>

        <p>
          There&apos;s also a leaderboard, there might be extra rewards for top
          contributooors.
        </p>
      </div>

      <div className="modal-actions">
        <button
          type="button"
          className="primary-btn"
          onClick={() => setShowWelcomeModal(false)}
        >
          Ok, its double time
        </button>
      </div>
    </div>
  </div>
)}

        {/* Confirm modal */}
        {showConfirmModal && (
          <div className="modal-backdrop">
            <div className="modal-card">
              <h2>Confirm Buy</h2>
              <p className="modal-small">
                You are about to send roughly $0.10 worth of ETH + gas fee to
                our contract, you will then be eligible to claim roughly $0.10
                worth of $TBAG from the claim tab (You will pay the gas fee to
                claim). These amounts will NOT be exact, the prices for both ETH
                and $TBAG are updated manually each day. By confirming here you
                do so know you may not send/receive the exact amounts, but close
                enough. The double $TBAG tokens, and bonus tokens will be
                claimable, or airdropped after Linea Exponent ends
              </p>
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => setShowConfirmModal(false)}
                  disabled={isBuying}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary-btn"
                  onClick={executeBuyTx}
                  disabled={isBuying}
                >
                  {isBuying ? "Processing..." : "Confirm Buy"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        .page-root {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          background: radial-gradient(circle at top, #1e293b 0, #020617 55%);
          color: #f9fafb;
          padding: 24px;
          position: relative;
          overflow: hidden;
          font-family: var(--font-barlow), system-ui, -apple-system,
            BlinkMacSystemFont, sans-serif;
        }

        .card-wrapper {
          position: relative;
          z-index: 2;
          max-width: 640px;
          width: 100%;
          margin-top: 40px;
        }

        .mint-card {
          background: radial-gradient(
            circle at top left,
            #0f172a 0,
            #020617 60%
          );
          border-radius: 24px;
          padding: 24px 24px 28px;
          box-shadow: 0 0 60px rgba(129, 140, 248, 0.35),
            0 0 120px rgba(236, 72, 153, 0.25);
          border: 1px solid rgba(148, 163, 184, 0.5);
          backdrop-filter: blur(12px);
        }

        .mint-card-header h1 {
          font-size: 1.9rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          margin: 0;
          font-weight: 500;
        }

        .mint-card-header p {
          margin: 6px 0 0;
          font-size: 0.9rem;
          color: #cbd5f5;
        }

        .status-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-top: 16px;
          gap: 8px;
          font-size: 0.8rem;
        }

        .status-pill {
          padding: 4px 10px;
          border-radius: 999px;
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          border: 1px solid rgba(148, 163, 184, 0.6);
        }

        .status-pill.ok {
          background: rgba(34, 197, 94, 0.12);
          border-color: rgba(34, 197, 94, 0.8);
          color: #bbf7d0;
        }

        .status-pill.bad {
          background: rgba(248, 113, 113, 0.1);
          border-color: rgba(248, 113, 113, 0.8);
          color: #fecaca;
        }

        .status-right {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 6px;
        }

        .status-address {
          opacity: 0.9;
          text-align: right;
        }

        .disconnect-btn,
        .switch-network-btn {
          padding: 4px 10px;
          border-radius: 999px;
          border: 1px solid rgba(148, 163, 184, 0.6);
          background: rgba(15, 23, 42, 0.9);
          color: #e5e7eb;
          font-size: 0.7rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          cursor: pointer;
        }

        .disconnect-btn:hover,
        .switch-network-btn:hover {
          background: rgba(30, 64, 175, 0.7);
        }

        .poh-row {
          margin-top: 8px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 0.78rem;
        }

        .poh-tag {
          padding: 3px 8px;
          border-radius: 999px;
          border: 1px solid rgba(148, 163, 184, 0.6);
        }

        .poh-tag.ok {
          background: rgba(34, 197, 94, 0.12);
          border-color: rgba(34, 197, 94, 0.8);
          color: #bbf7d0;
        }

        .poh-tag.bad {
          background: rgba(248, 113, 113, 0.1);
          border-color: rgba(248, 113, 113, 0.8);
          color: #fecaca;
        }

        .poh-tag.checking {
          opacity: 0.9;
        }

        .tab-header-row {
          margin-top: 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
        }

        .tab-row {
          display: inline-flex;
          border-radius: 999px;
          background: rgba(15, 23, 42, 0.9);
          border: 1px solid rgba(148, 163, 184, 0.4);
          padding: 3px;
        }

        .tab-btn {
          border: none;
          background: transparent;
          color: #e5e7eb;
          padding: 6px 16px;
          border-radius: 999px;
          font-size: 0.8rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          cursor: pointer;
        }

        .tab-btn.active {
          background: linear-gradient(135deg, #6366f1, #ec4899);
          box-shadow: 0 6px 15px rgba(129, 140, 248, 0.7);
        }

        .rank-pill-wrapper {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 4px;
        }

        .rank-pill {
          padding: 4px 10px;
          border-radius: 999px;
          border: 1px solid rgba(148, 163, 184, 0.7);
          background: radial-gradient(
            circle at top left,
            rgba(79, 70, 229, 0.5),
            rgba(15, 23, 42, 0.9)
          );
          font-size: 0.8rem;
          font-weight: 500;
          min-width: 48px;
          text-align: center;
        }

        .info-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
          margin-top: 18px;
        }

        .info-grid.info-grid-single {
          grid-template-columns: 1fr;
        }

        .info-box {
          padding: 10px 12px;
          border-radius: 14px;
          border: 1px solid rgba(148, 163, 184, 0.4);
          background: radial-gradient(
            circle at top left,
            rgba(79, 70, 229, 0.25),
            rgba(15, 23, 42, 0.8)
          );
        }

        .info-box:nth-child(2) {
          background: radial-gradient(
            circle at top,
            rgba(236, 72, 153, 0.25),
            rgba(15, 23, 42, 0.85)
          );
        }

        .info-box:nth-child(3) {
          background: radial-gradient(
            circle at top right,
            rgba(56, 189, 248, 0.25),
            rgba(15, 23, 42, 0.9)
          );
        }

        .label {
          display: block;
          font-size: 0.7rem;
          text-transform: uppercase;
          letter-spacing: 0.09em;
          color: #9ca3af;
          margin-bottom: 2px;
        }

        .value {
          font-size: 0.95rem;
          font-weight: 500;
        }

        .value.small {
          font-size: 0.8rem;
          line-height: 1.2;
          display: block;
          margin-top: 4px;
          color: #cbd5f5;
        }

        .mint-controls {
          margin-top: 20px;
          border-top: 1px dashed rgba(148, 163, 184, 0.5);
          padding-top: 16px;
        }

        .cost-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
          font-size: 0.88rem;
        }

        .actions-row {
          display: flex;
          margin-top: 12px;
        }

        .primary-btn {
          flex: 1;
          padding: 10px 14px;
          border-radius: 999px;
          border: none;
          font-size: 0.9rem;
          cursor: pointer;
          transition: transform 0.12s ease, box-shadow 0.12s ease,
            opacity 0.12s ease, background 0.12s ease;
          white-space: nowrap;
          background: linear-gradient(135deg, #6366f1, #ec4899);
          color: white;
          box-shadow: 0 12px 35px rgba(129, 140, 248, 0.6);
        }

        .primary-btn:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 14px 40px rgba(129, 140, 248, 0.9);
        }

        .primary-btn:disabled {
          opacity: 0.5;
          cursor: default;
        }

        .secondary-btn {
          padding: 8px 14px;
          border-radius: 999px;
          border: 1px solid rgba(148, 163, 184, 0.6);
          background: rgba(15, 23, 42, 0.9);
          color: #e5e7eb;
          font-size: 0.85rem;
          cursor: pointer;
          margin-right: 8px;
        }

        .secondary-btn:hover:not(:disabled) {
          background: rgba(30, 64, 175, 0.7);
        }

        .error-box {
          margin-top: 12px;
          padding: 8px 10px;
          border-radius: 8px;
          background: rgba(248, 113, 113, 0.1);
          border: 1px solid rgba(248, 113, 113, 0.7);
          font-size: 0.8rem;
          color: #fecaca;
        }

        .success-box {
          margin-top: 12px;
          padding: 8px 10px;
          border-radius: 8px;
          background: rgba(34, 197, 94, 0.1);
          border: 1px solid rgba(34, 197, 94, 0.8);
          font-size: 0.8rem;
          color: #bbf7d0;
        }

        .hint-text {
          margin-top: 10px;
          font-size: 0.75rem;
          color: #9ca3af;
        }

        .leaderboard-section {
          margin-top: 20px;
          border-top: 1px dashed rgba(148, 163, 184, 0.5);
          padding-top: 16px;
        }

        .leaderboard-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin-bottom: 8px;
        }

        .export-csv-btn {
          padding: 6px 12px;
          border-radius: 999px;
          border: 1px solid rgba(148, 163, 184, 0.6);
          background: linear-gradient(135deg, #6366f1, #ec4899);
          color: #fff;
          font-size: 0.72rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          cursor: pointer;
          white-space: nowrap;
          box-shadow: 0 8px 22px rgba(129, 140, 248, 0.35);
        }

        .export-csv-btn:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 10px 28px rgba(129, 140, 248, 0.65);
        }

        .export-csv-btn:disabled {
          opacity: 0.5;
          cursor: default;
        }

        .leaderboard-table-wrapper {
          max-height: 220px;
          overflow-y: auto;
          border-radius: 12px;
          border: 1px solid rgba(148, 163, 184, 0.4);
          background: rgba(15, 23, 42, 0.7);
        }

        .leaderboard-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.8rem;
        }

        .leaderboard-table thead {
          position: sticky;
          top: 0;
          background: rgba(15, 23, 42, 0.95);
        }

        .leaderboard-table th,
        .leaderboard-table td {
          padding: 6px 10px;
          text-align: left;
          border-bottom: 1px solid rgba(30, 64, 175, 0.3);
        }

        .leaderboard-table th {
          font-weight: 500;
          color: #9ca3af;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-size: 0.7rem;
        }

        .leaderboard-table tr:nth-child(even) td {
          background: rgba(15, 23, 42, 0.6);
        }

        .leaderboard-table tr:nth-child(odd) td {
          background: rgba(15, 23, 42, 0.9);
        }

        .leaderboard-table tr.self-row td {
          background: radial-gradient(
            circle at top left,
            rgba(129, 140, 248, 0.55),
            rgba(15, 23, 42, 0.95)
          );
          border-bottom-color: rgba(129, 140, 248, 0.9);
          box-shadow: 0 0 18px rgba(129, 140, 248, 0.7);
        }

        /* Modal */
        .modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(15, 23, 42, 0.8);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10;
        }

        .modal-card {
          width: 100%;
          max-width: 420px;
          background: radial-gradient(
            circle at top left,
            #020617 0,
            #020617 60%
          );
          border-radius: 20px;
          border: 1px solid rgba(148, 163, 184, 0.7);
          box-shadow: 0 0 40px rgba(129, 140, 248, 0.6);
          padding: 20px 18px 18px;
        }

        .modal-card h2 {
          margin: 0 0 8px;
          font-size: 1.2rem;
        }

        .modal-card p {
          margin: 4px 0;
          font-size: 0.9rem;
        }

        .modal-small {
          font-size: 0.78rem;
          color: #cbd5f5;
        }
        .modal-small p,
.modal-small li {
  font-size: 0.78rem; /* ensure everything inside is same size */
}

.modal-small p {
  margin: 6px 0 10px; /* space between paragraphs */
}

.modal-small ul {
  margin: 6px 0 10px;
  padding-left: 1.2rem;
}

.modal-small li:not(:last-child) {
  margin-bottom: 6px; /* space between bullet points */
}

        .modal-actions {
          display: flex;
          justify-content: flex-end;
          margin-top: 14px;
        }

        /* Background images */
        .bg-logo {
          position: absolute;
          top: -4%;
          left: 50%;
          transform: translateX(-50%);
          opacity: 0.18;
          pointer-events: none;
          z-index: 0;
          animation: floatLogo 10s ease-in-out infinite alternate;
        }

        .bg-logo img {
          max-width: 350px;
          height: auto;
        }

        .bg-img {
          position: absolute;
          opacity: 0.26;
          pointer-events: none;
          z-index: 0;
          animation-duration: 12s;
          animation-iteration-count: infinite;
          animation-timing-function: ease-in-out;
          animation-direction: alternate;
          will-change: transform;
        }

        .bg-img img {
          max-width: 340px;
          height: auto;
        }

        .bg-img-1 {
          top: 10%;
          left: 5%;
          animation-name: float1;
          transform: translate(0px, 0px) rotate(-2deg) scale(1);
        }

        .bg-img-2 {
          bottom: 6%;
          left: 7%;
          animation-name: float2;
          transform: translate(0px, 0px) rotate(2deg) scale(1.05);
        }

        .bg-img-3 {
          top: 12%;
          right: 6%;
          animation-name: float3;
          transform: translate(0px, 0px) rotate(3deg) scale(0.78);
        }

        .bg-img-4 {
          bottom: 4%;
          right: 7%;
          animation-name: float4;
          transform: translate(0px, 0px) rotate(-3deg) scale(1);
        }

        @keyframes floatLogo {
          0% {
            transform: translate(-50%, 0px) scale(1);
          }
          100% {
            transform: translate(-50%, -6px) scale(1.06);
          }
        }

        @keyframes float1 {
          0% {
            transform: translate(0px, 0px) rotate(-2deg) scale(1);
          }
          50% {
            transform: translate(10px, -6px) rotate(-4deg) scale(1.25);
          }
          100% {
            transform: translate(-4px, 4px) rotate(-3deg) scale(1.12);
          }
        }

        @keyframes float2 {
          0% {
            transform: translate(0px, 0px) rotate(2deg) scale(1.05);
          }
          50% {
            transform: translate(-12px, -10px) rotate(4deg) scale(1.25);
          }
          100% {
            transform: translate(8px, 6px) rotate(3deg) scale(1.08);
          }
        }

        @keyframes float3 {
          0% {
            transform: translate(0px, 0px) rotate(3deg) scale(0.78);
          }
          50% {
            transform: translate(-14px, 8px) rotate(5deg) scale(1.05);
          }
          100% {
            transform: translate(6px, -4px) rotate(4deg) scale(0.9);
          }
        }

        @keyframes float4 {
          0% {
            transform: translate(0px, 0px) rotate(-3deg) scale(1);
          }
          50% {
            transform: translate(12px, 10px) rotate(-5deg) scale(1.25);
          }
          100% {
            transform: translate(-6px, -6px) rotate(-4deg) scale(1.1);
          }
        }

        @media (max-width: 640px) {
          .mint-card {
            padding: 18px 16px 22px;
          }
          .mint-card-header h1 {
            font-size: 1.5rem;
          }
          .info-grid {
            grid-template-columns: 1fr;
          }
          .bg-logo img {
            max-width: 275px;
          }
          .bg-img img {
            max-width: 240px;
          }
          .tab-header-row {
            flex-direction: column;
            align-items: flex-start;
          }
          .rank-pill-wrapper {
            align-items: flex-start;
          }
          .leaderboard-header {
            align-items: flex-start;
            flex-direction: column;
          }
        }
      `}</style>
    </>
  );
}
