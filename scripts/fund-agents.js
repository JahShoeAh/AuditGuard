const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  Client,
  AccountId,
  PrivateKey,
  TokenId,
  TransferTransaction,
  AccountBalanceQuery,
  Hbar,
} = require('@hashgraph/sdk');

// Load config for GUARD token ID
const configPath = path.join(__dirname, '..', 'packages', 'sdk', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const GUARD_DECIMALS = 8;

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

async function fundAgents() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║              Fund Unfunded Agents with GUARD                  ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  // Try OPERATOR account first (has supply key for minting)
  let sourceId, sourceKey;

  if (process.env.OPERATOR_ACCOUNT_ID && process.env.OPERATOR_PRIVATE_KEY) {
    console.log('Using OPERATOR account as source...');
    sourceId = AccountId.fromString(process.env.OPERATOR_ACCOUNT_ID);
    sourceKey = parsePrivateKey(process.env.OPERATOR_PRIVATE_KEY, process.env.OPERATOR_PRIVATE_KEY_TYPE || 'ECDSA');
  } else {
    console.log('Using HEDERA account as source...');
    sourceId = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
    sourceKey = parsePrivateKey(process.env.HEDERA_PRIVATE_KEY, process.env.HEDERA_PRIVATE_KEY_TYPE);
  }

  // Get GUARD token ID from config
  const guardTokenId = TokenId.fromString(config.guardTokenId);

  const client = Client.forTestnet();
  client.setOperator(sourceId, sourceKey);
  client.setDefaultMaxTransactionFee(new Hbar(2));

  console.log(`💰 Source Account: ${sourceId.toString()}`);
  console.log(`🪙  GUARD Token: ${guardTokenId.toString()}\n`);

  // Check source balance
  try {
    const balance = await new AccountBalanceQuery().setAccountId(sourceId).execute(client);
    const tokenBalance = balance.tokens.get(guardTokenId);
    const sourceGuard = tokenBalance ? fromTokenUnits(tokenBalance.toNumber()) : 0;
    console.log(`Source balance: ${sourceGuard.toFixed(4)} GUARD\n`);

    if (sourceGuard < 150) {
      console.error(`❌ Insufficient GUARD in source account. Need at least 150 GUARD.`);
      console.log(`\nRun this first: npm run deploy:token  # or transfer GUARD to ${sourceId.toString()}\n`);
      client.close();
      process.exit(1);
    }
  } catch (err) {
    console.error(`❌ Error checking source balance: ${err.message}\n`);
    client.close();
    process.exit(1);
  }

  // Agents to fund
  const agentsToFund = [
    { name: 'static-analysis-047', accountId: '0.0.7951945', amount: 50 },
    { name: 'llm-contextual-003', accountId: '0.0.7951947', amount: 100 },
  ];

  for (const agent of agentsToFund) {
    console.log(`\n📤 Transferring ${agent.amount} GUARD to ${agent.name} (${agent.accountId})...`);

    try {
      const agentId = AccountId.fromString(agent.accountId);

      const transferTx = await new TransferTransaction()
        .addTokenTransfer(guardTokenId, sourceId, -toTokenUnits(agent.amount))
        .addTokenTransfer(guardTokenId, agentId, toTokenUnits(agent.amount))
        .freezeWith(client);

      const signed = await transferTx.sign(sourceKey);
      const submitted = await signed.execute(client);
      const receipt = await submitted.getReceipt(client);

      console.log(`✅ Successfully transferred ${agent.amount} GUARD to ${agent.name}`);
      console.log(`   Transaction: ${submitted.transactionId.toString()}`);
    } catch (err) {
      console.error(`❌ Failed to transfer to ${agent.name}: ${err.message}`);
    }
  }

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║                       ✅ Funding Complete                      ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');
  console.log('Now run: npm run dev:all\n');

  client.close();
}

fundAgents().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
