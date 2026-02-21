const CANONICAL_TYPE = {
  dex: 'dex',
  lending: 'lending',
  bridge: 'bridge',
  vault: 'vault',
  staking: 'staking',
  nft: 'nft',
  unknown: 'unknown',
};

const LABELS = {
  dex: 'DEX',
  lending: 'LENDING',
  bridge: 'BRIDGE',
  vault: 'VAULT',
  staking: 'STAKING',
  nft: 'NFT',
  unknown: 'UNKNOWN',
};

const COLORS = {
  dex: 'var(--accent-amber)',
  lending: 'var(--accent-cyan)',
  bridge: 'var(--accent-purple)',
  vault: 'var(--accent-green)',
  staking: 'var(--accent-gold)',
  nft: '#a78bfa',
  unknown: 'var(--accent-amber)',
};

const RAW_TO_CANONICAL = new Map([
  ['dex', CANONICAL_TYPE.dex],
  ['exchange', CANONICAL_TYPE.dex],
  ['amm', CANONICAL_TYPE.dex],
  ['lending', CANONICAL_TYPE.lending],
  ['lending_protocol', CANONICAL_TYPE.lending],
  ['loan', CANONICAL_TYPE.lending],
  ['borrow', CANONICAL_TYPE.lending],
  ['bridge', CANONICAL_TYPE.bridge],
  ['cross_chain_bridge', CANONICAL_TYPE.bridge],
  ['vault', CANONICAL_TYPE.vault],
  ['yield_aggregator', CANONICAL_TYPE.vault],
  ['aggregator', CANONICAL_TYPE.vault],
  ['staking', CANONICAL_TYPE.staking],
  ['staking_pool', CANONICAL_TYPE.staking],
  ['stake', CANONICAL_TYPE.staking],
  ['nft', CANONICAL_TYPE.nft],
  ['erc721', CANONICAL_TYPE.nft],
  ['erc1155', CANONICAL_TYPE.nft],
  ['multitoken', CANONICAL_TYPE.nft],
]);

export function normalizeAuctionType(rawValue) {
  const normalized = String(rawValue || '').trim().toLowerCase();
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

