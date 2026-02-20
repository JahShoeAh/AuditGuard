declare module "@0glabs/0g-serving-broker" {
  export function createZGComputeNetworkBroker(wallet: unknown): Promise<any>;
}

declare module "evmdecoder" {
  export interface ContractTypeInfo {
    name: string;
    standards: string[];
    proxies?: Array<{ address: string; standard: string; target: string }>;
    metadata?: boolean;
    baseUri?: boolean;
    enumeration?: boolean;
    receive?: string[];
  }

  export interface ContractInfo {
    isContract: boolean;
    fingerprint?: string;
    contractName?: string;
    contractType?: ContractTypeInfo;
    properties?: Record<string, unknown>;
    bytecode?: string;
  }

  export interface EvmDecoderConfig {
    eth: {
      url: string;
      http?: Record<string, unknown>;
      client?: Record<string, unknown>;
    };
    abi?: {
      directory?: string;
      searchRecursive?: boolean;
      fingerprintContracts?: boolean;
      requireContractMatch?: boolean;
      decodeAnonymous?: boolean;
      reconcileStructShapeFromTuples?: boolean;
    };
    contractInfo?: { maxCacheEntries?: number };
    logging?: { showDecodeWarnings?: boolean; showClassificationWarnings?: boolean };
  }

  export class EvmDecoder {
    constructor(config: EvmDecoderConfig);
    initialize(): Promise<void>;
    contractInfo(params: { address: string }): Promise<ContractInfo>;
    decodeFunctionCall(params: { input: string; address?: string }): Promise<unknown>;
  }
}

declare module "@anthropic-ai/sdk" {
  interface TextBlock {
    type: "text";
    text: string;
  }
  interface Message {
    content: TextBlock[];
    stop_reason: string;
  }
  interface MessagesCreateParams {
    model: string;
    max_tokens: number;
    system?: string;
    messages: Array<{ role: "user"; content: string }>;
  }
  class Messages {
    create(params: MessagesCreateParams): Promise<Message>;
  }
  export default class Anthropic {
    messages: Messages;
    constructor(opts: { apiKey: string });
  }
}
