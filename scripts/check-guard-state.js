const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  Client,
  AccountId,
  PrivateKey,
  TokenId,
  AccountBalanceQuery,
} = require('@hashgraph/sdk');

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

function fromTokenUnits(units) {
  return units / Math.pow(10, 8);
}

async function checkGuardState() {
  const operatorId = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
  const operatorKey = parsePrivateKey(process.env.HEDERA_PRIVATE_KEY, process.env.HEDERA_PRIVATE_KEY_TYPE);
  const guardTokenId = TokenId.fromString(process.env.GUARD_TOKEN_ID);

  const client = Client.forTestnet();
  client.setOperator(operatorId, operatorKey);

  console.log('Checking GUARD token state...\n');
  console.log(`Operator: ${operatorId.toString()}`);
  console.log(`GUARD Token: ${guardTokenId.toString()}\n`);

  try {
    const balance = await new AccountBalanceQuery().setAccountId(operatorId).execute(client);
    const tokenBalance = balance.tokens.get(guardTokenId);

    if (tokenBalance) {
      console.log(`✓ Operator IS associated with GUARD token`);
      console.log(`  Balance: ${fromTokenUnits(tokenBalance.toNumber()).toFixed(4)} GUARD`);
    } else {
      console.log(`✗ Operator is NOT associated with GUARD token`);
      console.log(`  This is the root cause! The operator account needs to be associated with GUARD.`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
  }

  client.close();
}

checkGuardState().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
