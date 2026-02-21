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

  const guardTokenId = TokenId.fromString(config.guardTokenId);
  const MIN_SOURCE_GUARD = 150;

  const candidates = [];
  if (process.env.OPERATOR_ACCOUNT_ID && process.env.OPERATOR_PRIVATE_KEY) {
    candidates.push({
      label: 'OPERATOR',
      id: AccountId.fromString(process.env.OPERATOR_ACCOUNT_ID),
      key: parsePrivateKey(process.env.OPERATOR_PRIVATE_KEY, process.env.OPERATOR_PRIVATE_KEY_TYPE || 'ECDSA'),
    });
  }
  if (process.env.HEDERA_ACCOUNT_ID && process.env.HEDERA_PRIVATE_KEY) {
    candidates.push({
      label: 'HEDERA',
      id: AccountId.fromString(process.env.HEDERA_ACCOUNT_ID),
      key: parsePrivateKey(process.env.HEDERA_PRIVATE_KEY, process.env.HEDERA_PRIVATE_KEY_TYPE),
    });
  }
  if (!candidates.length) {
    console.error('No OPERATOR or HEDERA credentials found in .env');
    process.exit(1);
  }

  let sourceId, sourceKey;
  const probeClient = Client.forTestnet();

  for (const c of candidates) {
    probeClient.setOperator(c.id, c.key);
    try {
      const bal = await new AccountBalanceQuery().setAccountId(c.id).execute(probeClient);
      const tokenBal = bal.tokens.get(guardTokenId);
      const guard = tokenBal ? fromTokenUnits(tokenBal.toNumber()) : 0;
      console.log(`${c.label} (${c.id}) balance: ${guard.toFixed(4)} GUARD`);
      if (guard >= MIN_SOURCE_GUARD) {
        sourceId = c.id;
        sourceKey = c.key;
        break;
      }
      console.log(`  -> insufficient (need ${MIN_SOURCE_GUARD}), trying next source...`);
    } catch (err) {
      console.log(`  -> error querying ${c.label}: ${err.message}`);
    }
  }
  probeClient.close();

  if (!sourceId) {
    console.error(`\nNo source account has >= ${MIN_SOURCE_GUARD} GUARD. Fund one of them first.\n`);
    process.exit(1);
  }

  const client = Client.forTestnet();
  client.setOperator(sourceId, sourceKey);
  client.setDefaultMaxTransactionFee(new Hbar(2));

  console.log(`\nUsing source: ${sourceId.toString()}`);
  console.log(`GUARD Token:  ${guardTokenId.toString()}\n`);

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
