const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  Client,
  AccountId,
  PrivateKey,
  TokenId,
  TokenMintTransaction,
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

async function mintAndTransfer() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║    Mint & Transfer GUARD Tokens (using OPERATOR_ACCOUNT)      ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  // Use OPERATOR account which has supply key
  const operatorId = AccountId.fromString(process.env.OPERATOR_ACCOUNT_ID);
  const operatorKey = parsePrivateKey(process.env.OPERATOR_PRIVATE_KEY, process.env.OPERATOR_PRIVATE_KEY_TYPE);

  // HEDERA account (the one that needs funds)
  const hederaId = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);

  const guardTokenId = TokenId.fromString(process.env.GUARD_TOKEN_ID);

  const client = Client.forTestnet();
  client.setOperator(operatorId, operatorKey);
  client.setDefaultMaxTransactionFee(new Hbar(5));

  console.log(`📋 Token Operator (supply key): ${operatorId.toString()}`);
  console.log(`📋 HEDERA Account (needs funds): ${hederaId.toString()}`);
  console.log(`📋 GUARD Token: ${guardTokenId.toString()}\n`);

  // Step 1: Mint 1000 GUARD
  const mintAmount = 1000;
  console.log(`Step 1: Minting ${mintAmount} GUARD...\n`);

  try {
    const mintTx = await new TokenMintTransaction()
      .setTokenId(guardTokenId)
      .setAmount(toTokenUnits(mintAmount))
      .freezeWith(client);

    const sign = await mintTx.sign(operatorKey);
    const submit = await sign.execute(client);
    const receipt = await submit.getReceipt(client);

    console.log(`✓ Successfully minted ${mintAmount} GUARD\n`);
  } catch (err) {
    console.error(`✗ Failed to mint: ${err.message}\n`);
    client.close();
    process.exit(1);
  }

  // Step 2: Check OPERATOR balance
  console.log(`Step 2: Checking OPERATOR balance...\n`);
  try {
    const balance = await new AccountBalanceQuery().setAccountId(operatorId).execute(client);
    const tokenBalance = balance.tokens.get(guardTokenId);
    const opGuard = tokenBalance ? fromTokenUnits(tokenBalance.toNumber()) : 0;
    console.log(`✓ OPERATOR balance: ${opGuard.toFixed(4)} GUARD\n`);
  } catch (err) {
    console.error(`✗ Error checking balance: ${err.message}\n`);
  }

  // Step 3: Transfer to HEDERA account
  console.log(`Step 3: Transferring 300 GUARD to HEDERA account...\n`);
  try {
    const transferTx = await new TransferTransaction()
      .addTokenTransfer(guardTokenId, operatorId, -toTokenUnits(300))
      .addTokenTransfer(guardTokenId, hederaId, toTokenUnits(300))
      .freezeWith(client);

    const sign = await transferTx.sign(operatorKey);
    const submit = await sign.execute(client);
    const receipt = await submit.getReceipt(client);

    console.log(`✓ Successfully transferred 300 GUARD\n`);
  } catch (err) {
    console.error(`✗ Failed to transfer: ${err.message}\n`);
    client.close();
    process.exit(1);
  }

  client.close();
  console.log('Done! Now run: npm run dev:all\n');
}

mintAndTransfer().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
