# Installing Slither for AuditGuard

## Quick Install

### macOS

```bash
# Install Python 3 if not already installed
brew install python3

# Install Slither
pip3 install slither-analyzer

# Install Solidity compiler
brew tap ethereum/ethereum
brew install solidity

# Verify installations
slither --version
solc --version
```

### Linux (Ubuntu/Debian)

```bash
# Install Python 3 and pip
sudo apt-get update
sudo apt-get install python3 python3-pip

# Install Slither
pip3 install slither-analyzer

# Install Solidity compiler
sudo add-apt-repository ppa:ethereum/ethereum
sudo apt-get update
sudo apt-get install solc

# Verify installations
slither --version
solc --version
```

### Using pip directly (all platforms)

```bash
# Install Slither (requires Python 3.8+)
pip3 install slither-analyzer

# For specific Solidity versions
pip3 install solc-select
solc-select install 0.8.0
solc-select use 0.8.0

# Verify
slither --version
```

## After Installation

Test the Slither agent:

```bash
# From project root
npm run test:slither
```

You should see:
```
✅ Slither is installed

📋 Test 2: Running Slither analysis on vulnerable contract...

🔍 Detected Vulnerabilities:

   1. [CRITICAL] reentrancy-eth
      ...
```

## Configuration (Optional)

To test Hedera integration, add to your `.env`:

```bash
SLITHER_AGENT_ACCOUNT_ID=0.0.7951945
SLITHER_AGENT_PRIVATE_KEY=<same_key_as_static-analysis-047>
```

The Slither agent uses the same account as `static-analysis-047` which is already funded with 50 GUARD.

## Troubleshooting

### "command not found: slither"

Add pip install location to PATH:

```bash
# Add to ~/.bashrc or ~/.zshrc
export PATH="$PATH:$HOME/.local/bin"

# Reload shell
source ~/.bashrc  # or source ~/.zshrc
```

### "solc not found"

```bash
# Install via pip
pip3 install solc-select
solc-select install 0.8.0
solc-select use 0.8.0
```

### Permission errors

```bash
# Use --user flag
pip3 install --user slither-analyzer
```

## Next Steps

Once Slither is installed:

1. ✅ Run tests: `npm run test:slither`
2. ✅ Start agent: `npm run agents:slither`
3. ✅ Monitor in dashboard

That's it! The Slither agent will now provide fast, accurate static analysis for your smart contract audits.
