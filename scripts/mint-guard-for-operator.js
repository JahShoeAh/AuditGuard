const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  Client,
  AccountId,
  PrivateKey,
  TokenId,
  TokenMintTransaction,
  Hbar,
} = require('@hashgraph/sdk');

const GUARD_DECIMALS = 8;

function toTokenUnits(guardAmount) {
  return Math.floor(guardAmount * Math.pow(10, GUARD_DECIMALS));
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

async function mintForOperator() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║         Mint GUARD Tokens for Operator Account               ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  const operatorId = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
  const operatorKey = parsePrivateKey(process.env.HEDERA_PRIVATE_KEY, process.env.HEDERA_PRIVATE_KEY_TYPE);
  const guardTokenId = TokenId.fromString(process.env.GUARD_TOKEN_ID);

  const client = Client.forTestnet();
  client.setOperator(operatorId, operatorKey);
  client.setDefaultMaxTransactionFee(new Hbar(5));

  console.log(`📋 Operator: ${operatorId.toString()}`);
  console.log(`📋 GUARD Token: ${guardTokenId.toString()}\n`);

  // Mint 1000 GUARD for operator (to cover fuzzer 200 + llm 50 + buffer)
  const mintAmount = 1000;
  console.log(`Minting ${mintAmount} GUARD for operator account...\n`);

  try {
    const mintTx = await new TokenMintTransaction()
      .setTokenId(guardTokenId)
      .setAmount(toTokenUnits(mintAmount))
      .freezeWith(client);

    const sign = await mintTx.sign(operatorKey);
    const submit = await sign.execute(client);
    const receipt = await submit.getReceipt(client);

    console.log(`✓ Successfully minted ${mintAmount} GUARD\n`);
    console.log(`Transaction: ${receipt.transactionId}\n`);
    console.log('Now run: npm run dev:all\n');
  } catch (err) {
    console.error(`✗ Failed to mint: ${err.message}\n`);
    process.exit(1);
  }

  client.close();
}

mintForOperator().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
