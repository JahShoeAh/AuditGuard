const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { ethers } = require('ethers');
const {
  Client,
  AccountId,
  PrivateKey,
  TransferTransaction,
  TokenId,
  AccountBalanceQuery,
  Hbar,
} = require('@hashgraph/sdk');

const GUARD_DECIMALS = 8;
const RPC_URL = 'https://testnet.hashio.io/api';

function toTokenUnits(guardAmount) {
  return Math.floor(guardAmount * Math.pow(10, GUARD_DECIMALS));
}

function fromTokenUnits(units) {
  return units / Math.pow(10, GUARD_DECIMALS);
}

function parsePrivateKey(rawKey, keyTypeHint = '') {
  const key = String(rawKey || '').trim().replace(/^['"]|['"]$/g, '');
  if (!key) throw new Error('Private key is empty');
  const normalizedHint = String(keyTypeHint || '').trim().toUpperCase();
  const stripped = key.startsWith('0x') ? key.slice(2) : key;
  const isHex32 = /^[0-9a-fA-F]{64}$/.test(stripped);
  if (normalizedHint === 'ECDSA') return PrivateKey.fromStringECDSA(stripped);
  if (normalizedHint === 'ED25519') return PrivateKey.fromStringED25519(stripped);
  if (isHex32) return PrivateKey.fromStringECDSA(stripped);
  return PrivateKey.fromString(key);
}

async function populateGuardTokens() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║        Populate Agent EVM Wallets with GUARD Tokens            ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  const operatorId = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
  const operatorKey = parsePrivateKey(process.env.HEDERA_PRIVATE_KEY, process.env.HEDERA_PRIVATE_KEY_TYPE);
  const guardTokenId = TokenId.fromString(process.env.GUARD_TOKEN_ID);

  const client = Client.forTestnet();
  client.setOperator(operatorId, operatorKey);
  client.setDefaultMaxTransactionFee(new Hbar(5));

  // Agents to fund
  const agents = [
    { env: 'FUZZER_ACCOUNT_ID', key_env: 'FUZZER_PRIVATE_KEY', name: 'fuzzer-012', amount: 200 },
    { env: 'LLM_ACCOUNT_ID', key_env: 'LLM_PRIVATE_KEY', name: 'llm-contextual-003', amount: 50 },
  ];

  console.log(`📋 Operator: ${operatorId.toString()}`);
  console.log(`📋 GUARD Token: ${guardTokenId.toString()}\n`);

  // Check operator balance first
  console.log('Checking operator GUARD balance in Hedera account...\n');
  try {
    const opBalance = await new AccountBalanceQuery()
      .setAccountId(operatorId)
      .execute(client);

    const opTokenBalance = opBalance.tokens.get(guardTokenId);
    const opGuard = opTokenBalance ? fromTokenUnits(opTokenBalance.toNumber()) : 0;
    console.log(`✓ Operator balance: ${opGuard.toFixed(4)} GUARD\n`);
  } catch (err) {
    console.error(`✗ Failed to check operator balance: ${err.message}\n`);
    client.close();
    process.exit(1);
  }

  // Transfer tokens to agents
  for (const agent of agents) {
    const agentAccountId = AccountId.fromString(process.env[agent.env]);
    console.log(`• ${agent.name} (${agentAccountId.toString()})`);

    try {
      // Check current balance
      const balance = await new AccountBalanceQuery()
        .setAccountId(agentAccountId)
        .execute(client);

      const tokenBalance = balance.tokens.get(guardTokenId);
      const currentGuard = tokenBalance ? fromTokenUnits(tokenBalance.toNumber()) : 0;
      console.log(`  Current balance: ${currentGuard.toFixed(4)} GUARD`);

      if (currentGuard < agent.amount) {
        const needed = agent.amount - currentGuard;
        console.log(`  Transferring: ${needed.toFixed(4)} GUARD...`);

        const transferTx = await new TransferTransaction()
          .addTokenTransfer(guardTokenId, operatorId, -toTokenUnits(needed))
          .addTokenTransfer(guardTokenId, agentAccountId, toTokenUnits(needed))
          .freezeWith(client);

        const sign = await transferTx.sign(operatorKey);
        const submit = await sign.execute(client);
        const receipt = await submit.getReceipt(client);

        console.log(`  ✓ Transfer succeeded\n`);
      } else {
        console.log(`  ✓ Already has sufficient balance\n`);
      }
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}\n`);
    }
  }

  client.close();
  console.log('Done!\n');
}

populateGuardTokens().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
