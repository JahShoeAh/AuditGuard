const CANONICAL_TYPE = {
  dex: "dex",
  lending: "lending",
  bridge: "bridge",
  vault: "vault",
  staking: "staking",
  derivatives: "derivatives",
  oracle: "oracle",
  governance: "governance",
  nft: "nft",
  unknown: "unknown",
};

const LABELS = {
  dex: "DEX",
  lending: "LENDING",
  bridge: "BRIDGE",
  vault: "VAULT",
  staking: "STAKING",
  derivatives: "DERIVATIVES",
  oracle: "ORACLE",
  governance: "GOVERNANCE",
  nft: "NFT",
  unknown: "UNKNOWN",
};

const COLORS = {
  dex: "var(--accent-amber)",
  lending: "var(--accent-cyan)",
  bridge: "var(--accent-purple)",
  vault: "var(--accent-green)",
  staking: "var(--accent-gold)",
  derivatives: "var(--accent-red)",
  oracle: "var(--accent-cyan)",
  governance: "var(--accent-purple)",
  nft: "var(--accent-gold)",
  unknown: "var(--accent-amber)",
};

const RAW_TO_CANONICAL = new Map([
  ["dex", CANONICAL_TYPE.dex],
  ["exchange", CANONICAL_TYPE.dex],
  ["amm", CANONICAL_TYPE.dex],
  ["lending", CANONICAL_TYPE.lending],
  ["lending_protocol", CANONICAL_TYPE.lending],
  ["loan", CANONICAL_TYPE.lending],
  ["borrow", CANONICAL_TYPE.lending],
  ["bridge", CANONICAL_TYPE.bridge],
  ["cross_chain_bridge", CANONICAL_TYPE.bridge],
  ["vault", CANONICAL_TYPE.vault],
  ["yield_aggregator", CANONICAL_TYPE.vault],
  ["aggregator", CANONICAL_TYPE.vault],
  ["staking", CANONICAL_TYPE.staking],
  ["staking_pool", CANONICAL_TYPE.staking],
  ["stake", CANONICAL_TYPE.staking],
  ["derivatives", CANONICAL_TYPE.derivatives],
  ["derivative", CANONICAL_TYPE.derivatives],
  ["perp", CANONICAL_TYPE.derivatives],
  ["perps", CANONICAL_TYPE.derivatives],
  ["perpetual", CANONICAL_TYPE.derivatives],
  ["futures", CANONICAL_TYPE.derivatives],
  ["options", CANONICAL_TYPE.derivatives],
  ["oracle", CANONICAL_TYPE.oracle],
  ["price_oracle", CANONICAL_TYPE.oracle],
  ["governance", CANONICAL_TYPE.governance],
  ["dao", CANONICAL_TYPE.governance],
  ["nft", CANONICAL_TYPE.nft],
  ["erc721", CANONICAL_TYPE.nft],
  ["erc1155", CANONICAL_TYPE.nft],
  ["non_fungible_token", CANONICAL_TYPE.nft],
  ["collectible", CANONICAL_TYPE.nft],
  ["multitoken", CANONICAL_TYPE.nft],
]);

export function normalizeAuctionType(rawValue) {
  const normalized = String(rawValue || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_");
  if (!normalized) return CANONICAL_TYPE.unknown;
  if (RAW_TO_CANONICAL.has(normalized)) return RAW_TO_CANONICAL.get(normalized);
  return CANONICAL_TYPE.unknown;
}

export function auctionTypeLabel(rawValue) {
  return LABELS[normalizeAuctionType(rawValue)] || LABELS.unknown;
}

export function auctionTypeColor(rawValue) {
  return COLORS[normalizeAuctionType(rawValue)] || COLORS.unknown;
}
