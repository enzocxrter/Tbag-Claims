"use client";

import React, { useEffect, useMemo, useState } from "react";
import Head from "next/head";
import { ethers } from "ethers";

// --------------------------------------------------
// Config
// --------------------------------------------------

const APP_NAME = "TBAG Claims";

// Linea Mainnet
const TARGET_CHAIN_ID_DEC = 59144;
const TARGET_CHAIN_ID_HEX = "0xe708";
const TARGET_NETWORK_LABEL = "Linea";

const TBAG_DECIMALS = 18;

// Production addresses
const TBAG_TOKEN_ADDRESS =
  process.env.NEXT_PUBLIC_TBAG_TOKEN_ADDRESS ??
  "0x67454b41baf8d29751cc64f60e3c62b5634567a4";

const NFT_COLLECTION_ADDRESS =
  process.env.NEXT_PUBLIC_BAGGIEZ_NFT_ADDRESS ??
  "0x0e1f9edf5a647b6cd305cec707e050ec41395d85";

// Deploy these, then set env vars in Vercel
const LEADERBOARD_CLAIM_ADDRESS = 0xA1A11707f1D768962CF04057BAC7a590e2eE9ce6
  process.env.NEXT_PUBLIC_LEADERBOARD_CLAIM_ADDRESS ?? "";

const NFT_CLAIM_ADDRESS = process.env.NEXT_PUBLIC_NFT_CLAIM_ADDRESS ?? "";

// NFT reward ranges
const SE_START_ID = 1;
const SE_END_ID = 333;
const STANDARD_START_ID = 334;
const STANDARD_END_ID = 3333;

const SE_REWARD_LABEL = "10,000";
const STANDARD_REWARD_LABEL = "3,000";

// Minimal ABIs expected from the claim contracts
const LEADERBOARD_CLAIM_ABI = [
  "function claimsActive() view returns (bool)",
  "function startTime() view returns (uint256)",
  "function vestingDuration() view returns (uint256)",
  "function claimCooldown() view returns (uint256)",
  "function allocation(address user) view returns (uint256)",
  "function claimed(address user) view returns (uint256)",
  "function lastClaim(address user) view returns (uint256)",
  "function vested(address user) view returns (uint256)",
  "function claimable(address user) view returns (uint256)",
  "function nextClaimTime(address user) view returns (uint256)",
  "function claim()",
];

const NFT_CLAIM_ABI = [
  "function claimsActive() view returns (bool)",
  "function currentPhase() view returns (uint256)",
  "function totalPhases() view returns (uint256)",
  "function claimed(uint256 tokenId, uint256 phase) view returns (bool)",
  "function rewardForToken(uint256 tokenId) view returns (uint256)",
  "function getClaimable(address user, uint256[] tokenIds) view returns (uint256 amount, uint256 eligibleCount, uint256[] eligibleIds)",
  "function claim(uint256[] tokenIds)",
];

const ERC721_ENUMERABLE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
];

declare global {
  interface Window {
    ethereum?: any;
  }
}

type ActiveTab = "main" | "baggiez";

type MainClaimData = {
  claimsActive: boolean;
  totalAllocation: ethers.BigNumber;
  claimedAmount: ethers.BigNumber;
  vestedAmount: ethers.BigNumber;
  claimableAmount: ethers.BigNumber;
  nextClaimTime: number;
  lastClaim: number;
};

type NFTClaimData = {
  claimsActive: boolean;
  currentPhase: number;
  totalPhases: number;
  ownedTokenIds: number[];
  eligibleTokenIds: number[];
  eligibleCount: number;
  claimableAmount: ethers.BigNumber;
};

const ZERO = ethers.BigNumber.from(0);

function formatTokenAmount(value?: ethers.BigNumber | null) {
  if (!value) return "0";
  const formatted = ethers.utils.formatUnits(value, TBAG_DECIMALS);
  const [whole, decimals = ""] = formatted.split(".");
  const trimmedDecimals = decimals.slice(0, 2).replace(/0+$/, "");
  return trimmedDecimals ? `${Number(whole).toLocaleString()}.${trimmedDecimals}` : Number(whole).toLocaleString();
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatCountdown(targetSeconds: number) {
  if (!targetSeconds) return "Claim Now";

  const nowSeconds = Math.floor(Date.now() / 1000);
  const diff = targetSeconds - nowSeconds;

  if (diff <= 0) return "Claim Now";

  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);

  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function rewardLabelForTokenId(tokenId: number) {
  if (tokenId >= SE_START_ID && tokenId <= SE_END_ID) return `${SE_REWARD_LABEL} TBAG`;
  if (tokenId >= STANDARD_START_ID && tokenId <= STANDARD_END_ID) return `${STANDARD_REWARD_LABEL} TBAG`;
  return "Not eligible";
}

export default function Home() {
  // --------------------------------------------------
  // Wallet / network
  // --------------------------------------------------
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [autoConnectEnabled, setAutoConnectEnabled] = useState(true);

  const numericChainId = useMemo(() => {
    if (!chainId) return null;
    return chainId.startsWith("0x") ? parseInt(chainId, 16) : parseInt(chainId, 10);
  }, [chainId]);

  const isOnTargetNetwork = numericChainId === TARGET_CHAIN_ID_DEC;

  // --------------------------------------------------
  // UI state
  // --------------------------------------------------
  const [activeTab, setActiveTab] = useState<ActiveTab>("main");
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [isClaimingMain, setIsClaimingMain] = useState(false);
  const [isClaimingNFT, setIsClaimingNFT] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState<null | "main" | "nft">(null);

  const [mainClaimData, setMainClaimData] = useState<MainClaimData | null>(null);
  const [nftClaimData, setNftClaimData] = useState<NFTClaimData | null>(null);

  const [searchedTokenId, setSearchedTokenId] = useState("");
  const [searchedTokenStatus, setSearchedTokenStatus] = useState<string | null>(null);
  const [isSearchingToken, setIsSearchingToken] = useState(false);

  // --------------------------------------------------
  // Providers / contracts
  // --------------------------------------------------
  const getProvider = () => {
    if (typeof window === "undefined" || !window.ethereum) return null;
    return new ethers.providers.Web3Provider(window.ethereum);
  };

  const getSigner = () => {
    const provider = getProvider();
    if (!provider) return null;
    return provider.getSigner();
  };

  const getLeaderboardContract = (withSigner = false) => {
    const providerOrSigner = withSigner ? getSigner() : getProvider();
    if (!providerOrSigner || !LEADERBOARD_CLAIM_ADDRESS) return null;
    return new ethers.Contract(LEADERBOARD_CLAIM_ADDRESS, LEADERBOARD_CLAIM_ABI, providerOrSigner);
  };

  const getNFTClaimContract = (withSigner = false) => {
    const providerOrSigner = withSigner ? getSigner() : getProvider();
    if (!providerOrSigner || !NFT_CLAIM_ADDRESS) return null;
    return new ethers.Contract(NFT_CLAIM_ADDRESS, NFT_CLAIM_ABI, providerOrSigner);
  };

  // --------------------------------------------------
  // Wallet actions
  // --------------------------------------------------
  const connectWallet = async () => {
    try {
      setErrorMessage(null);
      setSuccessMessage(null);

      if (typeof window === "undefined" || !window.ethereum) {
        setErrorMessage("MetaMask not found. Please install it to continue.");
        return;
      }

      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      const selected = accounts[0];

      setWalletAddress(selected);
      setAutoConnectEnabled(true);

      const cid = await window.ethereum.request({ method: "eth_chainId" });
      setChainId(cid);

      await loadAllClaimData(selected);
    } catch (err) {
      console.error("Error connecting wallet:", err);
      setErrorMessage("Failed to connect wallet.");
    }
  };

  const disconnectWallet = () => {
    setWalletAddress(null);
    setChainId(null);
    setMainClaimData(null);
    setNftClaimData(null);
    setSearchedTokenStatus(null);
    setErrorMessage(null);
    setSuccessMessage(null);
    setAutoConnectEnabled(false);
  };

  const switchToTargetNetwork = async () => {
    if (typeof window === "undefined" || !window.ethereum) {
      setErrorMessage("MetaMask not found.");
      return;
    }

    try {
      setErrorMessage(null);
      setSuccessMessage(null);

      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: TARGET_CHAIN_ID_HEX }],
      });

      const cid = await window.ethereum.request({ method: "eth_chainId" });
      setChainId(cid);

      if (walletAddress) await loadAllClaimData(walletAddress);

      setSuccessMessage(`Switched to ${TARGET_NETWORK_LABEL}.`);
    } catch (switchError: any) {
      if (switchError?.code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: TARGET_CHAIN_ID_HEX,
                chainName: TARGET_NETWORK_LABEL,
                nativeCurrency: { name: "Linea ETH", symbol: "ETH", decimals: 18 },
                rpcUrls: ["https://rpc.linea.build"],
                blockExplorerUrls: ["https://lineascan.build"],
              },
            ],
          });

          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: TARGET_CHAIN_ID_HEX }],
          });

          const cid = await window.ethereum.request({ method: "eth_chainId" });
          setChainId(cid);

          if (walletAddress) await loadAllClaimData(walletAddress);

          setSuccessMessage(`${TARGET_NETWORK_LABEL} added and selected.`);
        } catch (addError) {
          console.error("Error adding Linea network:", addError);
          setErrorMessage("Failed to add Linea network. Please add it manually.");
        }
      } else if (switchError?.code === 4001) {
        setErrorMessage("Network switch was rejected in your wallet.");
      } else {
        console.error("Error switching network:", switchError);
        setErrorMessage("Failed to switch network in MetaMask.");
      }
    }
  };

  // --------------------------------------------------
  // Data loading
  // --------------------------------------------------
  const loadMainClaimData = async (address: string) => {
    if (!LEADERBOARD_CLAIM_ADDRESS) {
      setMainClaimData(null);
      return;
    }

    const contract = getLeaderboardContract(false);
    if (!contract) return;

    const [
      claimsActive,
      totalAllocation,
      claimedAmount,
      vestedAmount,
      claimableAmount,
      nextClaimTimeBn,
      lastClaimBn,
    ] = await Promise.all([
      contract.claimsActive(),
      contract.allocation(address),
      contract.claimed(address),
      contract.vested(address),
      contract.claimable(address),
      contract.nextClaimTime(address),
      contract.lastClaim(address),
    ]);

    setMainClaimData({
      claimsActive,
      totalAllocation,
      claimedAmount,
      vestedAmount,
      claimableAmount,
      nextClaimTime: Number(nextClaimTimeBn),
      lastClaim: Number(lastClaimBn),
    });
  };

  const loadOwnedNFTIds = async (address: string): Promise<number[]> => {
    const provider = getProvider();
    if (!provider) return [];

    const nft = new ethers.Contract(NFT_COLLECTION_ADDRESS, ERC721_ENUMERABLE_ABI, provider);

    // This assumes the NFT contract supports ERC721Enumerable.
    // If it does not, replace this function with Alchemy NFT API lookup.
    const balanceBn = await nft.balanceOf(address);
    const balance = Number(balanceBn);

    const calls = Array.from({ length: balance }, (_, index) => nft.tokenOfOwnerByIndex(address, index));
    const ids = await Promise.all(calls);

    return ids.map((id) => Number(id)).sort((a, b) => a - b);
  };

  const loadNFTClaimData = async (address: string) => {
    if (!NFT_CLAIM_ADDRESS) {
      setNftClaimData(null);
      return;
    }

    const contract = getNFTClaimContract(false);
    if (!contract) return;

    const ownedTokenIds = await loadOwnedNFTIds(address);

    const [claimsActive, currentPhaseBn, totalPhasesBn] = await Promise.all([
      contract.claimsActive(),
      contract.currentPhase(),
      contract.totalPhases(),
    ]);

    let amount = ZERO;
    let eligibleCount = 0;
    let eligibleIds: ethers.BigNumber[] = [];

    if (ownedTokenIds.length > 0) {
      const result = await contract.getClaimable(address, ownedTokenIds);
      amount = result.amount ?? result[0];
      eligibleCount = Number(result.eligibleCount ?? result[1]);
      eligibleIds = result.eligibleIds ?? result[2];
    }

    setNftClaimData({
      claimsActive,
      currentPhase: Number(currentPhaseBn),
      totalPhases: Number(totalPhasesBn),
      ownedTokenIds,
      eligibleTokenIds: eligibleIds.map((id) => Number(id)),
      eligibleCount,
      claimableAmount: amount,
    });
  };

  const loadAllClaimData = async (address?: string | null) => {
    if (!address) return;

    try {
      setIsLoadingData(true);
      setErrorMessage(null);

      await Promise.all([loadMainClaimData(address), loadNFTClaimData(address)]);
    } catch (err) {
      console.error("Error loading claim data:", err);
      setErrorMessage("Error loading claim data. Check network and contract addresses.");
    } finally {
      setIsLoadingData(false);
    }
  };

  // --------------------------------------------------
  // Claim actions
  // --------------------------------------------------
  const handleMainClaim = async () => {
    try {
      setErrorMessage(null);
      setSuccessMessage(null);

      if (!walletAddress) return connectWallet();
      if (!isOnTargetNetwork) return switchToTargetNetwork();
      if (!LEADERBOARD_CLAIM_ADDRESS) {
        setErrorMessage("Main claim contract address is not configured yet.");
        return;
      }

      setIsClaimingMain(true);
      const contract = getLeaderboardContract(true);
      if (!contract) throw new Error("Leaderboard contract unavailable");

      const tx = await contract.claim();
      await tx.wait();

      setSuccessMessage("Main claim successful. TBAG secured.");
      setShowConfirmModal(null);
      await loadAllClaimData(walletAddress);
    } catch (err: any) {
      console.error("Main claim error:", err);
      handleClaimError(err, "Main claim failed.");
    } finally {
      setIsClaimingMain(false);
    }
  };

  const handleNFTClaim = async () => {
    try {
      setErrorMessage(null);
      setSuccessMessage(null);

      if (!walletAddress) return connectWallet();
      if (!isOnTargetNetwork) return switchToTargetNetwork();
      if (!NFT_CLAIM_ADDRESS) {
        setErrorMessage("Baggiez claim contract address is not configured yet.");
        return;
      }
      if (!nftClaimData || nftClaimData.eligibleTokenIds.length === 0) {
        setErrorMessage("No eligible Baggiez NFTs to claim for this phase.");
        return;
      }

      setIsClaimingNFT(true);
      const contract = getNFTClaimContract(true);
      if (!contract) throw new Error("NFT claim contract unavailable");

      const tx = await contract.claim(nftClaimData.eligibleTokenIds);
      await tx.wait();

      setSuccessMessage("Baggiez claim successful. TBAG secured.");
      setShowConfirmModal(null);
      await loadAllClaimData(walletAddress);
    } catch (err: any) {
      console.error("NFT claim error:", err);
      handleClaimError(err, "Baggiez claim failed.");
    } finally {
      setIsClaimingNFT(false);
    }
  };

  const handleClaimError = (err: any, fallback: string) => {
    const rawMsg =
      err?.error?.message || err?.data?.message || err?.reason || err?.message || String(err ?? "");
    const lower = rawMsg.toLowerCase();

    if (err?.code === "ACTION_REJECTED" || lower.includes("user rejected")) {
      setErrorMessage("Transaction rejected in wallet.");
    } else if (lower.includes("paused") || lower.includes("not active")) {
      setErrorMessage("Claims are not active right now.");
    } else if (lower.includes("nothing") || lower.includes("zero") || lower.includes("no tokens")) {
      setErrorMessage("There is nothing claimable right now.");
    } else if (lower.includes("cooldown")) {
      setErrorMessage("You have already claimed within the current 24h cooldown window.");
    } else if (lower.includes("insufficient") || lower.includes("transfer amount exceeds balance")) {
      setErrorMessage("The claim contract does not have enough TBAG funded yet.");
    } else {
      setErrorMessage(fallback);
    }
  };

  // --------------------------------------------------
  // NFT search
  // --------------------------------------------------
  const searchTokenStatus = async () => {
    try {
      setErrorMessage(null);
      setSearchedTokenStatus(null);
      setIsSearchingToken(true);

      if (!NFT_CLAIM_ADDRESS) {
        setSearchedTokenStatus("Baggiez claim contract is not configured yet.");
        return;
      }

      const tokenId = Number(searchedTokenId);
      if (!Number.isInteger(tokenId) || tokenId < 0) {
        setSearchedTokenStatus("Enter a valid NFT token ID.");
        return;
      }

      const contract = getNFTClaimContract(false);
      if (!contract) throw new Error("NFT claim contract unavailable");

      const phaseBn = await contract.currentPhase();
      const phase = Number(phaseBn);
      const alreadyClaimed = await contract.claimed(tokenId, phase);
      const rewardLabel = rewardLabelForTokenId(tokenId);

      if (rewardLabel === "Not eligible") {
        setSearchedTokenStatus(`NFT #${tokenId} is not eligible for TBAG claims.`);
      } else if (alreadyClaimed) {
        setSearchedTokenStatus(`NFT #${tokenId} has already claimed in Phase ${phase}. Reward tier: ${rewardLabel}.`);
      } else {
        setSearchedTokenStatus(`NFT #${tokenId} has NOT claimed in Phase ${phase}. Reward tier: ${rewardLabel}.`);
      }
    } catch (err) {
      console.error("NFT search error:", err);
      setSearchedTokenStatus("Could not check this NFT ID. Check network and contract address.");
    } finally {
      setIsSearchingToken(false);
    }
  };

  // --------------------------------------------------
  // Effects
  // --------------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined" || !window.ethereum) return;

    const handleAccountsChanged = (accounts: string[]) => {
      if (accounts.length === 0) {
        disconnectWallet();
      } else {
        const acc = accounts[0];
        setWalletAddress(acc);
        loadAllClaimData(acc).catch(console.error);
      }
    };

    const handleChainChanged = (cid: string) => {
      setChainId(cid);
      if (walletAddress) loadAllClaimData(walletAddress).catch(console.error);
    };

    if (autoConnectEnabled) {
      window.ethereum
        .request({ method: "eth_accounts" })
        .then((accounts: string[]) => {
          if (accounts.length > 0) {
            const acc = accounts[0];
            setWalletAddress(acc);
            loadAllClaimData(acc).catch(console.error);
          }
        })
        .catch(console.error);
    }

    window.ethereum
      .request({ method: "eth_chainId" })
      .then((cid: string) => setChainId(cid))
      .catch(console.error);

    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);

    return () => {
      if (!window.ethereum) return;
      window.ethereum.removeListener("accountsChanged", handleAccountsChanged);
      window.ethereum.removeListener("chainChanged", handleChainChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, autoConnectEnabled]);

  // --------------------------------------------------
  // Derived labels
  // --------------------------------------------------
  const mainButtonLabel = (() => {
    if (!walletAddress) return "Connect Wallet";
    if (!isOnTargetNetwork) return `Switch to ${TARGET_NETWORK_LABEL}`;
    if (!LEADERBOARD_CLAIM_ADDRESS) return "Contract Pending";
    if (isClaimingMain) return "Claiming...";
    if (!mainClaimData?.claimsActive) return "Claims Not Active";
    if (!mainClaimData.claimableAmount.gt(0)) return "Nothing Claimable";
    if (mainClaimData.nextClaimTime && formatCountdown(mainClaimData.nextClaimTime) !== "Claim Now") {
      return "Cooldown Active";
    }
    return "Claim TBAG";
  })();

  const nftButtonLabel = (() => {
    if (!walletAddress) return "Connect Wallet";
    if (!isOnTargetNetwork) return `Switch to ${TARGET_NETWORK_LABEL}`;
    if (!NFT_CLAIM_ADDRESS) return "Contract Pending";
    if (isClaimingNFT) return "Claiming...";
    if (!nftClaimData?.claimsActive) return "Claims Not Active";
    if (!nftClaimData.eligibleTokenIds.length) return "No Eligible NFTs";
    return "Claim All Eligible Baggiez";
  })();

  const mainClaimDisabled =
    isClaimingMain ||
    isLoadingData ||
    !walletAddress ||
    !isOnTargetNetwork ||
    !LEADERBOARD_CLAIM_ADDRESS ||
    !mainClaimData?.claimsActive ||
    !mainClaimData?.claimableAmount.gt(0) ||
    (mainClaimData?.nextClaimTime ? formatCountdown(mainClaimData.nextClaimTime) !== "Claim Now" : false);

  const nftClaimDisabled =
    isClaimingNFT ||
    isLoadingData ||
    !walletAddress ||
    !isOnTargetNetwork ||
    !NFT_CLAIM_ADDRESS ||
    !nftClaimData?.claimsActive ||
    !nftClaimData?.eligibleTokenIds.length;

  return (
    <>
      <Head>
        <title>{APP_NAME}</title>
      </Head>

      <div className="page-root">
        <div className="card">
          <div className="card-header">
            <h1>{APP_NAME}</h1>
            <p>Claim your $TBAG rewards on Linea. Secure the bag.</p>
          </div>

          <div className="status-row">
            <span className={`status-pill ${isOnTargetNetwork ? "ok" : "bad"}`}>
              {isOnTargetNetwork ? TARGET_NETWORK_LABEL : "Wrong Network"}
            </span>
            <div className="status-right">
              <span className="status-address">
                {walletAddress ? `Connected: ${shortAddress(walletAddress)}` : "Not connected"}
              </span>
              {walletAddress && (
                <button className="tiny-btn" type="button" onClick={disconnectWallet}>
                  Disconnect
                </button>
              )}
              {walletAddress && !isOnTargetNetwork && (
                <button className="tiny-btn" type="button" onClick={switchToTargetNetwork}>
                  Switch Network
                </button>
              )}
            </div>
          </div>

          <div className="tab-header-row">
            <div className="tabs-row">
              <button className={`tab-btn ${activeTab === "main" ? "active" : ""}`} onClick={() => setActiveTab("main")}>
                Main Claims
              </button>
              <button className={`tab-btn ${activeTab === "baggiez" ? "active" : ""}`} onClick={() => setActiveTab("baggiez")}>
                Baggiez Claims
              </button>
            </div>
          </div>

          {activeTab === "main" && (
            <>
              <div className="info-grid two">
                <div className="info-box">
                  <span className="label">Total Claim Amount</span>
                  <span className="value">{walletAddress ? `${formatTokenAmount(mainClaimData?.totalAllocation)} TBAG` : "-"}</span>
                </div>
                <div className="info-box">
                  <span className="label">Already Claimed</span>
                  <span className="value">{walletAddress ? `${formatTokenAmount(mainClaimData?.claimedAmount)} TBAG` : "-"}</span>
                </div>
                <div className="info-box">
                  <span className="label">Claimable Now</span>
                  <span className="value">{walletAddress ? `${formatTokenAmount(mainClaimData?.claimableAmount)} TBAG` : "-"}</span>
                </div>
                <div className="info-box">
                  <span className="label">Left To Claim</span>
                  <span className="value">
                    {walletAddress && mainClaimData
                      ? `${formatTokenAmount(mainClaimData.totalAllocation.sub(mainClaimData.claimedAmount))} TBAG`
                      : "-"}
                  </span>
                </div>
              </div>

              <div className="info-grid single">
                <div className="info-box">
                  <span className="label">Next Claim</span>
                  <span className="value">
                    {walletAddress && mainClaimData ? formatCountdown(mainClaimData.nextClaimTime) : "-"}
                  </span>
                </div>
              </div>

              <div className="actions-row">
                <button
                  className="primary-btn"
                  onClick={() => {
                    if (!walletAddress) return connectWallet();
                    if (!isOnTargetNetwork) return switchToTargetNetwork();
                    setShowConfirmModal("main");
                  }}
                  disabled={walletAddress ? mainClaimDisabled : false}
                >
                  {mainButtonLabel}
                </button>
              </div>

              <p className="hint">
                Main leaderboard claims vest linearly over 90 days and can be claimed once every 24 hours.
              </p>
            </>
          )}

          {activeTab === "baggiez" && (
            <>
              <div className="info-grid two">
                <div className="info-box">
                  <span className="label">Current Phase</span>
                  <span className="value">
                    {nftClaimData ? `${nftClaimData.currentPhase} / ${nftClaimData.totalPhases}` : "-"}
                  </span>
                </div>
                <div className="info-box">
                  <span className="label">NFTs Owned</span>
                  <span className="value">{walletAddress ? nftClaimData?.ownedTokenIds.length ?? "-" : "-"}</span>
                </div>
                <div className="info-box">
                  <span className="label">Eligible This Phase</span>
                  <span className="value">{walletAddress ? nftClaimData?.eligibleCount ?? "-" : "-"}</span>
                </div>
                <div className="info-box">
                  <span className="label">Claimable TBAG</span>
                  <span className="value">{walletAddress ? `${formatTokenAmount(nftClaimData?.claimableAmount)} TBAG` : "-"}</span>
                </div>
              </div>

              <div className="nft-search-box">
                <span className="label">Search NFT Claim Status</span>
                <div className="search-row">
                  <input
                    value={searchedTokenId}
                    onChange={(e) => setSearchedTokenId(e.target.value)}
                    placeholder="Enter NFT ID"
                    inputMode="numeric"
                  />
                  <button className="secondary-btn" type="button" onClick={searchTokenStatus} disabled={isSearchingToken}>
                    {isSearchingToken ? "Checking..." : "Search"}
                  </button>
                </div>
                {searchedTokenStatus && <p className="search-result">{searchedTokenStatus}</p>}
              </div>

              <div className="actions-row">
                <button
                  className="primary-btn"
                  onClick={() => {
                    if (!walletAddress) return connectWallet();
                    if (!isOnTargetNetwork) return switchToTargetNetwork();
                    setShowConfirmModal("nft");
                  }}
                  disabled={walletAddress ? nftClaimDisabled : false}
                >
                  {nftButtonLabel}
                </button>
              </div>

              <p className="hint">
                Baggiez claims are phase-based. Each eligible NFT can claim 25% per active phase. Missed phases cannot be claimed later.
              </p>
            </>
          )}

          {errorMessage && <div className="error-box">{errorMessage}</div>}
          {successMessage && <div className="success-box">{successMessage}</div>}
          {isLoadingData && <div className="hint">Loading claim data from Linea…</div>}
        </div>

        <div className="leaderboard-card">
          <div className="leaderboard-header">
            <span className="label">Claim Rules</span>
            <span className="leaderboard-sub">Linea Mainnet</span>
          </div>
          <div className="rules-list">
            <p><strong>Main Claims:</strong> 90-day linear vesting, claimable once every 24 hours.</p>
            <p><strong>Baggiez SE:</strong> NFT IDs {SE_START_ID}–{SE_END_ID} receive {SE_REWARD_LABEL} TBAG total.</p>
            <p><strong>Baggiez Standard:</strong> NFT IDs {STANDARD_START_ID}–{STANDARD_END_ID} receive {STANDARD_REWARD_LABEL} TBAG total.</p>
            <p><strong>NFT Phases:</strong> 4 manual claim phases, 25% per phase. Missed phases expire.</p>
          </div>
        </div>

        {showConfirmModal && (
          <div className="modal-backdrop">
            <div className="modal-card">
              <h2>{showConfirmModal === "main" ? "Confirm Main Claim" : "Confirm Baggiez Claim"}</h2>
              <p className="modal-body">
                {showConfirmModal === "main"
                  ? `You are about to claim ${formatTokenAmount(mainClaimData?.claimableAmount)} TBAG from your vested leaderboard allocation.`
                  : `You are about to claim ${formatTokenAmount(nftClaimData?.claimableAmount)} TBAG for all currently eligible Baggiez NFTs in your wallet.`}
              </p>
              <div className="modal-actions">
                <button type="button" className="secondary-btn" onClick={() => setShowConfirmModal(null)} disabled={isClaimingMain || isClaimingNFT}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary-btn"
                  onClick={showConfirmModal === "main" ? handleMainClaim : handleNFTClaim}
                  disabled={isClaimingMain || isClaimingNFT}
                >
                  {isClaimingMain || isClaimingNFT ? "Claiming..." : "Confirm Claim"}
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
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background: radial-gradient(circle at top, #020617 0, #020617 55%);
          color: #f9fafb;
          padding: 24px;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
          gap: 16px;
        }
        .card {
          max-width: 540px;
          width: 100%;
          background: radial-gradient(circle at top left, #0f172a 0, #020617 60%);
          border-radius: 24px;
          padding: 20px 20px 24px;
          border: 1px solid rgba(148, 163, 184, 0.5);
          box-shadow: 0 0 50px rgba(129, 140, 248, 0.45);
        }
        .card-header h1 {
          margin: 0;
          font-size: 1.7rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .card-header p {
          margin: 6px 0 0;
          font-size: 0.9rem;
          color: #cbd5f5;
        }
        .status-row {
          margin-top: 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 0.8rem;
          gap: 8px;
        }
        .status-pill {
          padding: 4px 10px;
          border-radius: 999px;
          border: 1px solid rgba(148, 163, 184, 0.6);
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }
        .status-pill.ok {
          background: rgba(34, 197, 94, 0.14);
          border-color: rgba(34, 197, 94, 0.8);
          color: #bbf7d0;
        }
        .status-pill.bad {
          background: rgba(248, 113, 113, 0.12);
          border-color: rgba(248, 113, 113, 0.8);
          color: #fecaca;
        }
        .status-right {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 4px;
        }
        .status-address {
          opacity: 0.9;
        }
        .tiny-btn {
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
        .tiny-btn:hover {
          background: rgba(37, 99, 235, 0.8);
        }
        .tab-header-row {
          margin-top: 18px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
        }
        .tabs-row {
          display: inline-flex;
          border-radius: 999px;
          border: 1px solid rgba(148, 163, 184, 0.4);
          background: rgba(15, 23, 42, 0.9);
          padding: 3px;
        }
        .tab-btn {
          border: none;
          background: transparent;
          color: #e5e7eb;
          padding: 6px 18px;
          border-radius: 999px;
          font-size: 0.8rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          cursor: pointer;
        }
        .tab-btn.active {
          background: linear-gradient(135deg, #6366f1, #ec4899);
          box-shadow: 0 6px 18px rgba(129, 140, 248, 0.9);
        }
        .info-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
          margin-top: 16px;
        }
        .info-grid.two {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .info-grid.single {
          grid-template-columns: 1fr;
        }
        .info-box,
        .nft-search-box {
          padding: 10px 12px;
          border-radius: 14px;
          border: 1px solid rgba(148, 163, 184, 0.4);
          background: radial-gradient(circle at top left, rgba(79, 70, 229, 0.3), rgba(15, 23, 42, 0.95));
        }
        .nft-search-box {
          margin-top: 16px;
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
        .search-row {
          display: flex;
          gap: 8px;
          margin-top: 8px;
        }
        .search-row input {
          flex: 1;
          border-radius: 999px;
          border: 1px solid rgba(148, 163, 184, 0.6);
          background: rgba(15, 23, 42, 0.95);
          color: #f9fafb;
          padding: 8px 12px;
          outline: none;
        }
        .search-result {
          margin: 8px 0 0;
          font-size: 0.78rem;
          color: #cbd5f5;
        }
        .actions-row {
          margin-top: 18px;
        }
        .primary-btn {
          width: 100%;
          padding: 10px 14px;
          border-radius: 999px;
          border: none;
          font-size: 0.9rem;
          cursor: pointer;
          background: linear-gradient(135deg, #6366f1, #ec4899);
          color: white;
          box-shadow: 0 12px 30px rgba(129, 140, 248, 0.7);
          transition: transform 0.12s ease, box-shadow 0.12s ease, opacity 0.12s ease;
        }
        .primary-btn:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 16px 40px rgba(129, 140, 248, 0.95);
        }
        .primary-btn:disabled {
          opacity: 0.5;
          cursor: default;
        }
        .secondary-btn {
          padding: 8px 14px;
          border-radius: 999px;
          border: 1px solid rgba(148, 163, 184, 0.6);
          background: rgba(15, 23, 42, 0.95);
          color: #e5e7eb;
          font-size: 0.85rem;
          cursor: pointer;
        }
        .secondary-btn:hover:not(:disabled) {
          background: rgba(37, 99, 235, 0.8);
        }
        .secondary-btn:disabled {
          opacity: 0.5;
          cursor: default;
        }
        .hint {
          margin-top: 10px;
          font-size: 0.75rem;
          color: #9ca3af;
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
        .leaderboard-card {
          max-width: 540px;
          width: 100%;
          background: radial-gradient(circle at top left, #020617 0, #020617 60%);
          border-radius: 20px;
          border: 1px solid rgba(148, 163, 184, 0.7);
          box-shadow: 0 0 35px rgba(129, 140, 248, 0.4);
          padding: 14px 16px 16px;
        }
        .leaderboard-header {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          margin-bottom: 8px;
        }
        .leaderboard-sub {
          font-size: 0.7rem;
          color: #9ca3af;
        }
        .rules-list p {
          margin: 7px 0;
          font-size: 0.78rem;
          color: #cbd5f5;
        }
        .modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(15, 23, 42, 0.85);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 20;
          padding: 18px;
        }
        .modal-card {
          max-width: 420px;
          width: 100%;
          background: radial-gradient(circle at top left, #020617 0, #020617 60%);
          border-radius: 20px;
          border: 1px solid rgba(148, 163, 184, 0.7);
          box-shadow: 0 0 40px rgba(129, 140, 248, 0.7);
          padding: 18px 18px 16px;
        }
        .modal-card h2 {
          margin: 0 0 8px;
          font-size: 1.15rem;
        }
        .modal-body {
          font-size: 0.78rem;
          color: #cbd5f5;
        }
        .modal-actions {
          margin-top: 14px;
          display: flex;
          justify-content: flex-end;
          gap: 8px;
        }
        .modal-actions .primary-btn {
          width: auto;
        }
        @media (max-width: 640px) {
          .card {
            padding: 18px 14px 22px;
          }
          .card-header h1 {
            font-size: 1.45rem;
          }
          .info-grid,
          .info-grid.two {
            grid-template-columns: 1fr;
          }
          .leaderboard-card {
            padding: 14px 12px 16px;
          }
          .tab-header-row {
            flex-direction: column;
            align-items: flex-start;
          }
          .tabs-row {
            width: 100%;
          }
          .tab-btn {
            flex: 1;
            padding-left: 10px;
            padding-right: 10px;
          }
          .search-row {
            flex-direction: column;
          }
        }
      `}</style>
    </>
  );
}
