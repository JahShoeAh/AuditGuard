/**
 * Type declarations for packages/sdk/hedera-provider.js
 * Consumed by the TypeScript agent layer.
 */
import type { ethers } from "ethers";

export const HEDERA_NETWORK: { name: string; chainId: number };
export const DEFAULT_HEDERA_TESTNET_RPC: string;
export const HEDERA_LEGACY_GAS_PRICE: bigint;

export function assertAddress(value: string, label: string): string;
export function patchProviderFeeData(provider: { getFeeData: unknown }): void;
export function applyPollingSubscriber(provider: ethers.JsonRpcProvider): void;
export function parseRpcCandidates(): string[];
export function buildProviderWithFallback(): ethers.AbstractProvider;
