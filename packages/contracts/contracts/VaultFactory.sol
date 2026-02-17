// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IHederaTokenService} from "./interfaces/IHederaTokenService.sol";
import {AuditVault} from "./AuditVault.sol";

/// @title AuditGuard Vault Factory
/// @notice Factory and registry for AuditVault instances. Each audited smart contract gets
///         a dedicated vault deployed via CREATE2 for deterministic addressing. The factory
///         provides priority-sorted querying and re-audit detection for the agent ecosystem.
/// @dev Emits rich events consumed by Agent Systems (Orchestrator, Scanner), the iNFT system,
///      and the Frontend dashboard.
contract VaultFactory is ReentrancyGuard, Ownable {
    // ──────────────────────────────────────────────
    //  Constants
    // ──────────────────────────────────────────────

    /// @notice Hedera Token Service precompile address.
    IHederaTokenService internal constant HTS = IHederaTokenService(address(0x167));

    /// @dev Hedera response code for successful operations.
    int64 internal constant HTS_SUCCESS = 22;

    /// @dev Hedera response code when token is already associated.
    int64 internal constant HTS_TOKEN_ALREADY_ASSOCIATED = 194;

    // ──────────────────────────────────────────────
    //  State
    // ──────────────────────────────────────────────

    /// @notice GUARD token EVM address.
    address public guardToken;

    /// @notice AgentRegistry contract address.
    address public agentRegistry;

    /// @notice AuditAuction contract — authorized to draw funds from vaults.
    address public auctionContract;

    /// @notice PaymentSettlement contract — authorized to draw funds from vaults.
    address public paymentSettlement;

    /// @notice Maps covered contract address to its dedicated AuditVault instance.
    mapping(address => address) public vaultFor;

    /// @notice Ordered list of all deployed vault addresses for enumeration.
    address[] public allVaults;

    /// @notice Maps depositor address to the list of vaults they have funded, so a
    ///         developer can see all contracts they are sponsoring.
    mapping(address => address[]) public depositorVaults;

    /// @dev Fast lookup for registered vaults (used by callback permissions).
    mapping(address => bool) public isVault;

    /// @dev Prevents duplicate entries in depositorVaults.
    mapping(address => mapping(address => bool)) private _depositorHasVault;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────

    /// @notice Emitted when a new AuditVault is deployed for a contract.
    /// @dev [Frontend] Powers vault creation notifications and the vault list.
    ///      [iNFT] May trigger new Contract Health iNFT minting.
    event VaultCreated(
        address indexed contractAddress,
        address indexed vault,
        address indexed creator,
        string contractChain
    );

    /// @notice Emitted when a vault signals that automatic re-audit conditions are met.
    /// @dev [Agent Systems] Orchestrator listens and calls AuditAuction.createAuditJob.
    ///      [iNFT] Triggers new audit job iNFT creation.
    event AutoAuditTriggered(
        address indexed contractAddress,
        address indexed vault,
        string reason
    );

    /// @notice Emitted when this factory is associated with the GUARD token on HTS.
    event GuardTokenAssociated(address indexed token);

    // ──────────────────────────────────────────────
    //  Constructor
    // ──────────────────────────────────────────────

    /// @notice Deploys the VaultFactory.
    /// @param _guardToken GUARD token EVM address.
    /// @param _agentRegistry AgentRegistry contract address.
    constructor(address _guardToken, address _agentRegistry) Ownable(msg.sender) {
        require(_guardToken != address(0), "VaultFactory: guard token is zero");
        guardToken = _guardToken;
        agentRegistry = _agentRegistry;
    }

    // ──────────────────────────────────────────────
    //  Vault Creation
    // ──────────────────────────────────────────────

    /// @notice Creates a dedicated AuditVault for a smart contract. Anyone can create a
    ///         vault for any contract if one does not already exist.
    /// @dev Deploys via CREATE2 using contractAddress as salt, making vault addresses
    ///      deterministic and predictable by other contracts without querying the factory.
    ///      Initializes the vault with the supplied config and registers authorized drawers
    ///      (AuditAuction, PaymentSettlement).
    ///      [Frontend] Powers the "create vault" flow on the dashboard.
    /// @param contractAddress The smart contract to create a vault for.
    /// @param contractChain Chain identifier (e.g. "hedera-testnet", "ethereum-mainnet").
    /// @param config Initial vault configuration rules.
    /// @return vaultAddress The deployed AuditVault's address.
    function createVault(
        address contractAddress,
        string calldata contractChain,
        AuditVault.VaultConfig calldata config
    ) external returns (address vaultAddress) {
        require(contractAddress != address(0), "VaultFactory: contract address is zero");
        require(vaultFor[contractAddress] == address(0), "VaultFactory: vault already exists");

        // Deploy via CREATE2 with contractAddress as salt for deterministic addressing
        bytes32 salt = bytes32(uint256(uint160(contractAddress)));
        AuditVault vault = new AuditVault{salt: salt}();
        vaultAddress = address(vault);

        // Build authorized drawers list from configured contracts
        uint256 drawerCount = 0;
        if (auctionContract != address(0)) drawerCount++;
        if (paymentSettlement != address(0)) drawerCount++;

        address[] memory drawers = new address[](drawerCount);
        uint256 idx = 0;
        if (auctionContract != address(0)) {
            drawers[idx++] = auctionContract;
        }
        if (paymentSettlement != address(0)) {
            drawers[idx++] = paymentSettlement;
        }

        // Initialize the vault with identity, config, and access control
        vault.initialize(
            contractAddress,
            contractChain,
            msg.sender,
            guardToken,
            agentRegistry,
            config,
            drawers
        );

        // Associate vault with GUARD token on HTS (best-effort — can retry via vault directly)
        try vault.associateGuardToken() {} catch {}

        // Register in factory state
        vaultFor[contractAddress] = vaultAddress;
        allVaults.push(vaultAddress);
        isVault[vaultAddress] = true;

        // Track creator as initial depositor-vault association
        if (!_depositorHasVault[msg.sender][vaultAddress]) {
            _depositorHasVault[msg.sender][vaultAddress] = true;
            depositorVaults[msg.sender].push(vaultAddress);
        }

        emit VaultCreated(contractAddress, vaultAddress, msg.sender, contractChain);
    }

    // ──────────────────────────────────────────────
    //  Query Functions
    // ──────────────────────────────────────────────

    /// @notice Returns all vaults sorted by currentBalance descending, with their balances.
    /// @dev [Agent Systems] THE function Scanner/Orchestrator agents use to decide which
    ///      contracts to audit next — "Agents autonomously re-prioritize based on available
    ///      budgets." Orchestrator calls this to pick highest-value targets.
    ///      [Frontend] Powers the "top contracts by budget" leaderboard.
    ///      This is a view function — no gas cost when called off-chain via eth_call.
    /// @return vaults Vault addresses sorted by descending balance.
    /// @return balances Parallel array of vault balances.
    function getVaultsByPriority()
        external
        view
        returns (address[] memory vaults, uint256[] memory balances)
    {
        uint256 len = allVaults.length;
        vaults = new address[](len);
        balances = new uint256[](len);

        for (uint256 i = 0; i < len; i++) {
            vaults[i] = allVaults[i];
            balances[i] = AuditVault(allVaults[i]).currentBalance();
        }

        // Selection sort descending by balance
        for (uint256 i = 0; i < len; i++) {
            uint256 maxIdx = i;
            for (uint256 j = i + 1; j < len; j++) {
                if (balances[j] > balances[maxIdx]) {
                    maxIdx = j;
                }
            }
            if (maxIdx != i) {
                (vaults[i], vaults[maxIdx]) = (vaults[maxIdx], vaults[i]);
                (balances[i], balances[maxIdx]) = (balances[maxIdx], balances[i]);
            }
        }
    }

    /// @notice Returns vaults where a re-audit is due or an audit trigger is pending.
    /// @dev [Agent Systems] Scanner Agent polls this periodically to detect contracts
    ///      needing attention. Maps to the spec's "auto-trigger new auctions when certain
    ///      thresholds are met (e.g., TVL increases 10x)".
    ///      [iNFT] Used to identify contracts whose Health iNFTs need status updates.
    /// @return vaults Vault addresses needing re-audit.
    function getVaultsNeedingReaudit() external view returns (address[] memory vaults) {
        uint256 len = allVaults.length;
        address[] memory temp = new address[](len);
        uint256 count = 0;

        for (uint256 i = 0; i < len; i++) {
            AuditVault vault = AuditVault(allVaults[i]);
            if (vault.isReauditDue() || vault.auditTriggerPending()) {
                temp[count++] = allVaults[i];
            }
        }

        vaults = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            vaults[i] = temp[i];
        }
    }

    /// @notice Returns the vault address for a given contract, or address(0) if none exists.
    /// @param contractAddress The covered contract address.
    /// @return vault The AuditVault address.
    function getVaultFor(address contractAddress) external view returns (address vault) {
        return vaultFor[contractAddress];
    }

    /// @notice Returns all deployed vault addresses.
    /// @dev [Frontend] Used for full vault enumeration on the explorer page.
    /// @return vaults Array of all AuditVault addresses.
    function getAllVaults() external view returns (address[] memory vaults) {
        return allVaults;
    }

    /// @notice Returns all vaults a depositor has funded.
    /// @dev [Frontend] Powers the "my sponsored contracts" view for depositors.
    /// @param depositor Depositor address.
    /// @return vaults Array of vault addresses the depositor has funded.
    function getDepositorVaults(address depositor) external view returns (address[] memory vaults) {
        return depositorVaults[depositor];
    }

    // ──────────────────────────────────────────────
    //  Vault Callbacks
    // ──────────────────────────────────────────────

    /// @notice Callback from a vault when auto-audit conditions are triggered.
    /// @dev Only callable by registered vaults. Re-emits the trigger at the factory level
    ///      with indexed contract and vault addresses for efficient event filtering.
    ///      [Agent Systems] Orchestrator listens to this factory-level event to create
    ///      new AuditAuction jobs.
    ///      [iNFT] Triggers new audit job iNFT creation.
    /// @param _contractAddress The covered contract that triggered the re-audit.
    /// @param reason Human-readable trigger reason (e.g. "reaudit_interval_elapsed",
    ///        "balance_threshold_crossed").
    function onAutoAuditTriggered(address _contractAddress, string calldata reason) external {
        require(isVault[msg.sender], "VaultFactory: caller is not a vault");
        emit AutoAuditTriggered(_contractAddress, msg.sender, reason);
    }

    /// @notice Callback from a vault when a new depositor funds it for the first time.
    /// @dev Only callable by registered vaults. Maintains the depositorVaults mapping
    ///      so depositors can enumerate all vaults they sponsor.
    /// @param depositor The depositor's address.
    /// @param vault The vault being funded.
    function registerDepositor(address depositor, address vault) external {
        require(isVault[msg.sender], "VaultFactory: caller is not a vault");
        require(msg.sender == vault, "VaultFactory: vault mismatch");

        if (!_depositorHasVault[depositor][vault]) {
            _depositorHasVault[depositor][vault] = true;
            depositorVaults[depositor].push(vault);
        }
    }

    // ──────────────────────────────────────────────
    //  Admin
    // ──────────────────────────────────────────────

    /// @notice Sets the AuditAuction contract address. Only callable by owner.
    /// @dev New vaults created after this call will include the auction contract as an
    ///      authorized drawer. Existing vaults are not retroactively updated.
    /// @param _auctionContract AuditAuction contract address.
    function setAuctionContract(address _auctionContract) external onlyOwner {
        require(_auctionContract != address(0), "VaultFactory: address is zero");
        auctionContract = _auctionContract;
    }

    /// @notice Sets the PaymentSettlement contract address. Only callable by owner.
    /// @dev New vaults created after this call will include the settlement contract as an
    ///      authorized drawer. Existing vaults are not retroactively updated.
    /// @param _paymentSettlement PaymentSettlement contract address.
    function setPaymentSettlement(address _paymentSettlement) external onlyOwner {
        require(_paymentSettlement != address(0), "VaultFactory: address is zero");
        paymentSettlement = _paymentSettlement;
    }

    /// @notice Sets the AgentRegistry contract address. Only callable by owner.
    /// @dev New vaults created after this call will use the updated registry for
    ///      monitoring tier checks.
    /// @param _agentRegistry AgentRegistry contract address.
    function setAgentRegistry(address _agentRegistry) external onlyOwner {
        require(_agentRegistry != address(0), "VaultFactory: address is zero");
        agentRegistry = _agentRegistry;
    }

    /// @notice Associates this factory contract with the GUARD token through HTS precompile.
    /// @dev Call post-deployment on Hedera JSON-RPC flows where constructor precompile
    ///      calls can revert.
    function associateGuardToken() external onlyOwner nonReentrant {
        int64 responseCode = HTS.tokenAssociate(address(this), guardToken);
        require(
            responseCode == HTS_SUCCESS || responseCode == HTS_TOKEN_ALREADY_ASSOCIATED,
            "VaultFactory: token association failed"
        );
        emit GuardTokenAssociated(guardToken);
    }

    // ──────────────────────────────────────────────
    //  Address Prediction
    // ──────────────────────────────────────────────

    /// @notice Computes the deterministic CREATE2 address for a vault before deployment.
    /// @dev Other contracts can predict vault addresses without querying the factory.
    ///      Uses the same salt derivation as createVault (contractAddress cast to bytes32).
    /// @param contractAddress The covered contract address used as salt.
    /// @return predicted The predicted vault address.
    function predictVaultAddress(address contractAddress) external view returns (address predicted) {
        bytes32 salt = bytes32(uint256(uint160(contractAddress)));
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                salt,
                keccak256(type(AuditVault).creationCode)
            )
        );
        return address(uint160(uint256(hash)));
    }
}
