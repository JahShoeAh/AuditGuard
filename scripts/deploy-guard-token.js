/**
 * Deploy GUARD Token on Hedera Testnet using Native HTS
 * 
 * This script deploys the AuditGuard utility token as a native Hedera Token Service (HTS)
 * fungible token. The token is used for staking, payments, governance, and agent interactions
 * in the AuditGuard autonomous agent marketplace.
 */

const path = require('path');
const fs = require('fs');

// Load .env from repo root (handles running from any directory)
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  Client,
  PrivateKey,
  AccountId,
  TokenCreateTransaction,
  TokenType,
  TokenAssociateTransaction,
  TransferTransaction,
  AccountBalanceQuery,
  Hbar
} = require('@hashgraph/sdk');

// ============================================================================
// CONFIGURATION
// ============================================================================

const TOKEN_CONFIG = {
  name: 'AuditGuard Token',
  symbol: 'GUARD',
  decimals: 8, // Supports micro-transactions (0.001 GUARD minimum)
  initialSupply: 10_000_000, // 10M GUARD
};

const INITIAL_ALLOCATIONS = {
  SCANNER_AGENT: 100,
  AUDITOR_AGENT_1: 500,  // Static Analysis (commodity tier)
  AUDITOR_AGENT_2: 750,  // Fuzzer (specialized tier)
  AUDITOR_AGENT_3: 1000, // LLM Contextual (premium tier)
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert GUARD amount to smallest unit (with 8 decimals)
 */
function toTokenUnits(guardAmount) {
  return Math.floor(guardAmount * Math.pow(10, TOKEN_CONFIG.decimals));
}

/**
 * Convert token units to GUARD amount
 */
function fromTokenUnits(units) {
  return units / Math.pow(10, TOKEN_CONFIG.decimals);
}

/**
 * Parse Hedera private key with deterministic curve selection.
 * If key is hex (0x...), default to ECDSA unless PRIVATE_KEY_TYPE override is set.
 */
function parsePrivateKey(rawKey, keyTypeHint = '') {
  const key = String(rawKey || '').trim().replace(/^['"]|['"]$/g, '');
  if (!key) {
    throw new Error('Private key is empty');
  }

  const normalizedHint = String(keyTypeHint || '').trim().toUpperCase();
  const stripped = key.startsWith('0x') ? key.slice(2) : key;
  const isHex32 = /^[0-9a-fA-F]{64}$/.test(stripped);

  if (normalizedHint === 'ECDSA') {
    return PrivateKey.fromStringECDSA(stripped);
  }
  if (normalizedHint === 'ED25519') {
    return PrivateKey.fromStringED25519(stripped);
  }

  if (isHex32) {
    // Hedera Portal commonly provides ECDSA private keys in hex format.
    return PrivateKey.fromStringECDSA(stripped);
  }

  return PrivateKey.fromString(key);
}

/**
 * Convert Hedera Token ID to EVM address format
 * Format: 0.0.X -> 0x000000000000000000000000000000000000XXXX
 */
function tokenIdToEvmAddress(tokenId) {
  return `0x${tokenId.toSolidityAddress()}`;
}

/**
 * Load agent account info from environment
 */
function loadAgentAccounts() {
  const agents = [];
  
  const agentConfigs = [
    {
      name: 'Scanner Agent',
      accountIdKey: 'SCANNER_AGENT_ACCOUNT_ID',
      privateKeyKey: 'SCANNER_AGENT_PRIVATE_KEY',
      allocation: INITIAL_ALLOCATIONS.SCANNER_AGENT,
    },
    {
      name: 'Auditor Agent 1 (Static Analysis)',
      accountIdKey: 'AUDITOR_AGENT_1_ACCOUNT_ID',
      privateKeyKey: 'AUDITOR_AGENT_1_PRIVATE_KEY',
      allocation: INITIAL_ALLOCATIONS.AUDITOR_AGENT_1,
    },
    {
      name: 'Auditor Agent 2 (Fuzzer)',
      accountIdKey: 'AUDITOR_AGENT_2_ACCOUNT_ID',
      privateKeyKey: 'AUDITOR_AGENT_2_PRIVATE_KEY',
      allocation: INITIAL_ALLOCATIONS.AUDITOR_AGENT_2,
    },
    {
      name: 'Auditor Agent 3 (LLM Contextual)',
      accountIdKey: 'AUDITOR_AGENT_3_ACCOUNT_ID',
      privateKeyKey: 'AUDITOR_AGENT_3_PRIVATE_KEY',
      allocation: INITIAL_ALLOCATIONS.AUDITOR_AGENT_3,
    },
  ];

  for (const config of agentConfigs) {
    const accountId = process.env[config.accountIdKey];
    const privateKey = process.env[config.privateKeyKey];

    if (!accountId || accountId === '0.0.XXXXXX' || !privateKey) {
      console.log(`⚠️  Skipping ${config.name}: Missing credentials in .env`);
      continue;
    }

    try {
      agents.push({
        name: config.name,
        accountId: AccountId.fromString(accountId),
        privateKey: parsePrivateKey(privateKey, process.env.AGENT_PRIVATE_KEY_TYPE),
        allocation: config.allocation,
      });
    } catch (error) {
      console.log(`⚠️  Skipping ${config.name}: Invalid credentials format`);
      console.log(`   Error: ${error.message}`);
    }
  }

  return agents;
}

/**
 * Save token info to packages/sdk/config.json
 */
function saveTokenConfig(tokenId, evmAddress) {
  const configPath = path.join(__dirname, '..', 'packages', 'sdk', 'config.json');
  
  let existingConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      existingConfig = JSON.parse(content);
    } catch (error) {
      console.log(`⚠️  Could not parse existing config.json, will overwrite: ${error.message}`);
    }
  }

  const newConfig = {
    ...existingConfig,
    guardTokenId: tokenId,
    guardTokenEvmAddress: evmAddress,
  };

  fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
  console.log(`\n✅ Token configuration saved to ${configPath}`);
}

// ============================================================================
// MAIN DEPLOYMENT FUNCTION
// ============================================================================

async function deployGuardToken() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║        GUARD Token Deployment - Hedera Testnet (HTS)           ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // ============================================================================
  // 1. INITIALIZE CLIENT
  // ============================================================================
  
  console.log('📡 Initializing Hedera Client...\n');

  const operatorId = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
  const operatorKey = parsePrivateKey(
    process.env.HEDERA_PRIVATE_KEY,
    process.env.HEDERA_PRIVATE_KEY_TYPE
  );

  if (!operatorId || !operatorKey) {
    throw new Error('Missing HEDERA_ACCOUNT_ID or HEDERA_PRIVATE_KEY in .env');
  }

  const client = Client.forTestnet();
  client.setOperator(operatorId, operatorKey);
  
  // Increase max transaction fee for token operations
  client.setDefaultMaxTransactionFee(new Hbar(10));

  console.log(`   Treasury/Deployer Account: ${operatorId.toString()}`);
  console.log(`   Operator key type hint: ${process.env.HEDERA_PRIVATE_KEY_TYPE || 'auto (hex -> ECDSA)'}`);
  console.log(`   Network: Hedera Testnet\n`);

  // ============================================================================
  // 2. CREATE TOKEN
  // ============================================================================
  
  console.log('🪙  Creating GUARD Token...\n');
  console.log(`   Name: ${TOKEN_CONFIG.name}`);
  console.log(`   Symbol: ${TOKEN_CONFIG.symbol}`);
  console.log(`   Decimals: ${TOKEN_CONFIG.decimals}`);
  console.log(`   Initial Supply: ${TOKEN_CONFIG.initialSupply.toLocaleString()} GUARD`);
  console.log(`   Admin Key: ${operatorId.toString()}`);
  console.log(`   Supply Key: ${operatorId.toString()}`);
  console.log(`   Freeze Key: null (freely transferable)`);
  console.log(`   Wipe Key: null`);
  console.log(`   Pause Key: ${operatorId.toString()}\n`);

  try {
    const tokenCreateTx = await new TokenCreateTransaction()
      .setTokenName(TOKEN_CONFIG.name)
      .setTokenSymbol(TOKEN_CONFIG.symbol)
      .setDecimals(TOKEN_CONFIG.decimals)
      .setInitialSupply(toTokenUnits(TOKEN_CONFIG.initialSupply))
      .setTreasuryAccountId(operatorId)
      .setTokenType(TokenType.FungibleCommon)
      .setAdminKey(operatorKey.publicKey)
      .setSupplyKey(operatorKey.publicKey)
      .setPauseKey(operatorKey.publicKey)
      // Freeze and Wipe keys intentionally null for permissionless transfers
      .setMaxTransactionFee(new Hbar(30))
      .freezeWith(client);

    const tokenCreateSign = await tokenCreateTx.sign(operatorKey);
    const tokenCreateSubmit = await tokenCreateSign.execute(client);
    const tokenCreateReceipt = await tokenCreateSubmit.getReceipt(client);
    const tokenId = tokenCreateReceipt.tokenId;

    if (!tokenId) {
      throw new Error('Token creation failed: No token ID in receipt');
    }

    console.log(`✅ Token Created Successfully!\n`);
    console.log(`   Token ID: ${tokenId.toString()}`);
    
    const evmAddress = tokenIdToEvmAddress(tokenId);
    console.log(`   EVM Address: ${evmAddress}`);
    console.log(`   (Use this address in Solidity contracts via HTS precompile at 0x167)\n`);

    // ============================================================================
    // 3. ASSOCIATE TOKEN WITH AGENT ACCOUNTS
    // ============================================================================
    
    const agents = loadAgentAccounts();
    
    if (agents.length === 0) {
      console.log('⚠️  No valid agent accounts found in .env - skipping associations and transfers\n');
    } else {
      console.log(`🔗 Associating GUARD token with ${agents.length} agent account(s)...\n`);

      for (const agent of agents) {
        try {
          console.log(`   Processing ${agent.name}...`);
          console.log(`      Account: ${agent.accountId.toString()}`);

          // Associate token with agent account (signed by agent's key)
          const associateTx = await new TokenAssociateTransaction()
            .setAccountId(agent.accountId)
            .setTokenIds([tokenId])
            .freezeWith(client);

          const associateSign = await associateTx.sign(agent.privateKey);
          const associateSubmit = await associateSign.execute(client);
          const associateReceipt = await associateSubmit.getReceipt(client);

          console.log(`      ✅ Token associated`);

          // Transfer initial allocation
          const transferTx = await new TransferTransaction()
            .addTokenTransfer(tokenId, operatorId, -toTokenUnits(agent.allocation))
            .addTokenTransfer(tokenId, agent.accountId, toTokenUnits(agent.allocation))
            .freezeWith(client);

          const transferSign = await transferTx.sign(operatorKey);
          const transferSubmit = await transferSign.execute(client);
          const transferReceipt = await transferSubmit.getReceipt(client);

          console.log(`      ✅ Transferred ${agent.allocation} GUARD\n`);

        } catch (error) {
          console.log(`      ❌ Failed: ${error.message}\n`);
        }
      }

      // ============================================================================
      // 4. QUERY AND DISPLAY FINAL BALANCES
      // ============================================================================
      
      console.log('📊 Final GUARD Token Balances:\n');
      console.log('   ┌─────────────────────────────────────────┬──────────────────┐');
      console.log('   │ Account                                 │ Balance (GUARD)  │');
      console.log('   ├─────────────────────────────────────────┼──────────────────┤');

      // Treasury balance
      try {
        const treasuryBalance = await new AccountBalanceQuery()
          .setAccountId(operatorId)
          .execute(client);
        
        const treasuryTokenBalance = treasuryBalance.tokens.get(tokenId);
        const treasuryGuard = treasuryTokenBalance ? fromTokenUnits(treasuryTokenBalance.toNumber()) : 0;
        
        console.log(`   │ Treasury (${operatorId.toString().padEnd(20)}) │ ${treasuryGuard.toLocaleString().padStart(16)} │`);
      } catch (error) {
        console.log(`   │ Treasury (${operatorId.toString().padEnd(20)}) │ Error querying   │`);
      }

      // Agent balances
      for (const agent of agents) {
        try {
          const agentBalance = await new AccountBalanceQuery()
            .setAccountId(agent.accountId)
            .execute(client);
          
          const agentTokenBalance = agentBalance.tokens.get(tokenId);
          const agentGuard = agentTokenBalance ? fromTokenUnits(agentTokenBalance.toNumber()) : 0;
          
          const displayName = agent.name.length > 20 ? agent.name.substring(0, 17) + '...' : agent.name;
          console.log(`   │ ${displayName.padEnd(39)} │ ${agentGuard.toLocaleString().padStart(16)} │`);
        } catch (error) {
          console.log(`   │ ${agent.name.padEnd(39)} │ Error querying   │`);
        }
      }

      console.log('   └─────────────────────────────────────────┴──────────────────┘\n');
    }

    // ============================================================================
    // 5. SAVE CONFIGURATION
    // ============================================================================
    
    saveTokenConfig(tokenId.toString(), evmAddress);

    console.log('\n╔════════════════════════════════════════════════════════════════╗');
    console.log('║                    Deployment Complete! 🎉                     ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');
    console.log('📋 Next Steps:\n');
    console.log('   1. Share the Token ID and EVM address with your agent development team');
    console.log('   2. Update your Solidity contracts to reference the EVM address');
    console.log('   3. Agents can now interact with GUARD via HTS precompile (0x167)');
    console.log('   4. Run agent scripts to begin autonomous marketplace operations\n');

    client.close();

  } catch (error) {
    console.error('\n❌ Deployment Failed!\n');
    console.error(`Error: ${error.message}`);
    console.error(`\nStack trace:\n${error.stack}`);
    
    if (error.status && error.status.toString) {
      console.error(`\nHedera Status: ${error.status.toString()}`);
    }
    
    client.close();
    process.exit(1);
  }
}

// ============================================================================
// EXECUTION
// ============================================================================

// Validate required environment variables
if (!process.env.HEDERA_ACCOUNT_ID || !process.env.HEDERA_PRIVATE_KEY) {
  console.error('❌ Missing required environment variables!');
  console.error('   Please ensure HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY are set in .env\n');
  process.exit(1);
}

// Run deployment
deployGuardToken()
  .catch((error) => {
    console.error('\n❌ Unexpected error during deployment:');
    console.error(error);
    process.exit(1);
  });
