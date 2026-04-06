const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  Client,
  AccountId,
  PrivateKey,
  TokenId,
  TokenAssociateTransaction,
  TransferTransaction,
  AccountBalanceQuery,
  Hbar,
} = require('@hashgraph/sdk');

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

async function fixGuardOperator() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║     Fix GUARD Token Operator Association & Distribution        ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  const operatorId = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
  const operatorKey = parsePrivateKey(process.env.HEDERA_PRIVATE_KEY, process.env.HEDERA_PRIVATE_KEY_TYPE);
  const guardTokenId = TokenId.fromString(process.env.GUARD_TOKEN_ID);

  const client = Client.forTestnet();
  client.setOperator(operatorId, operatorKey);
  client.setDefaultMaxTransactionFee(new Hbar(5));

  console.log(`📋 Operator: ${operatorId.toString()}`);
  console.log(`📋 GUARD Token: ${guardTokenId.toString()}\n`);

  // Step 1: Associate operator with GUARD token
  console.log('Step 1: Associating operator with GUARD token...');
  try {
    const associateTx = await new TokenAssociateTransaction()
      .setAccountId(operatorId)
      .setTokenIds([guardTokenId])
      .freezeWith(client);

    const sign = await associateTx.sign(operatorKey);
    const submit = await sign.execute(client);
    const receipt = await submit.getReceipt(client);

    console.log(`✓ Operator associated with GUARD token\n`);
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes('TOKEN_ALREADY_ASSOCIATED')) {
      console.log(`✓ Operator already associated with GUARD token\n`);
    } else {
      console.error(`✗ Failed to associate operator: ${msg}\n`);
      client.close();
      process.exit(1);
    }
  }

  // Step 2: Check treasury balance
  console.log('Step 2: Checking treasury balance...');
  try {
    const balance = await new AccountBalanceQuery().setAccountId(operatorId).execute(client);
    const tokenBalance = balance.tokens.get(guardTokenId);
    const treasuryGuard = tokenBalance ? fromTokenUnits(tokenBalance.toNumber()) : 0;
    console.log(`✓ Treasury balance: ${treasuryGuard.toFixed(4)} GUARD\n`);

    if (treasuryGuard < 300) {
      console.log(`⚠ Warning: Treasury has only ${treasuryGuard.toFixed(4)} GUARD`);
      console.log(`  Agents need 200 + 50 = 250 GUARD minimum\n`);
    }
  } catch (err) {
    console.error(`✗ Failed to check balance: ${err.message}\n`);
    client.close();
    process.exit(1);
  }

  // Step 3: Transfer tokens to agents
  console.log('Step 3: Transferring GUARD to agents...\n');

  const agents = [
    { env: 'FUZZER_ACCOUNT_ID', name: 'fuzzer-012', amount: 200 },
    { env: 'LLM_ACCOUNT_ID', name: 'llm-contextual-003', amount: 50 },
  ];

  for (const agent of agents) {
    const agentAccountId = AccountId.fromString(process.env[agent.env]);
    console.log(`• ${agent.name} (${agentAccountId.toString()})`);

    try {
      const balance = await new AccountBalanceQuery().setAccountId(agentAccountId).execute(client);
      const tokenBalance = balance.tokens.get(guardTokenId);
      const currentGuard = tokenBalance ? fromTokenUnits(tokenBalance.toNumber()) : 0;

      console.log(`  Current: ${currentGuard.toFixed(4)} GUARD`);

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
        console.log(`  ✓ Already sufficient\n`);
      }
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}\n`);
    }
  }

  client.close();
  console.log('Done! Now try: npm run dev:all\n');
}

fixGuardOperator().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
