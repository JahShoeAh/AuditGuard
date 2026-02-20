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

async function checkBalances() {
  const operatorId = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
  const operatorKey = parsePrivateKey(process.env.HEDERA_PRIVATE_KEY, process.env.HEDERA_PRIVATE_KEY_TYPE);
  const guardTokenId = TokenId.fromString(process.env.GUARD_TOKEN_ID);

  const client = Client.forTestnet();
  client.setOperator(operatorId, operatorKey);

  console.log('Checking Hedera account GUARD balances...\n');
  console.log(`Token: ${guardTokenId.toString()}\n`);

  const accounts = [
    { env: 'HEDERA_ACCOUNT_ID', name: 'Operator' },
    { env: 'SCANNER_ACCOUNT_ID', name: 'Scanner' },
    { env: 'STATIC_ACCOUNT_ID', name: 'Static Analysis' },
    { env: 'FUZZER_ACCOUNT_ID', name: 'Fuzzer' },
    { env: 'LLM_ACCOUNT_ID', name: 'LLM' },
  ];

  for (const acc of accounts) {
    try {
      const accountId = AccountId.fromString(process.env[acc.env]);
      const balance = await new AccountBalanceQuery().setAccountId(accountId).execute(client);
      const tokenBalance = balance.tokens.get(guardTokenId);
      const guardAmount = tokenBalance ? fromTokenUnits(tokenBalance.toNumber()) : 0;

      console.log(`${acc.name.padEnd(20)}: ${guardAmount.toFixed(4)} GUARD`);
    } catch (err) {
      console.log(`${acc.name.padEnd(20)}: Error - ${err.message}`);
    }
  }

  client.close();
}

checkBalances().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
