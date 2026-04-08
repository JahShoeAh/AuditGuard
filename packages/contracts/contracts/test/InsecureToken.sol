// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title InsecureToken
/// @notice Minimal ERC20-like token with several intentional security weaknesses
///         for static-analysis testing purposes.
/// @dev INTENTIONALLY VULNERABLE — do not use in production.
///
/// Vulnerabilities baked in:
///   1. Reentrancy in burnFrom()     — state updated AFTER external call
///   2. tx.origin auth in transfer() — susceptible to phishing/forwarding attacks
///   3. Unchecked return value       — low-level call result in notifyReceiver() ignored
///   4. Arbitrary mint (no access control) — anyone can mint tokens to themselves
///   5. Owner can drain any account  — forceBurn() has no limit; abusive centralisation
///   6. Missing zero-address checks  — transfer/approve accept address(0)
contract InsecureToken {
    string  public name     = "InsecureToken";
    string  public symbol   = "ISEC";
    uint8   public decimals = 18;

    address public owner;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner_, address indexed spender, uint256 value);
    event Minted(address indexed to, uint256 amount);
    event Burned(address indexed from, uint256 amount);

    constructor(uint256 initialSupply) {
        owner = msg.sender;
        // Vulnerability 4: mint to deployer, but mint() itself has no guard
        _mint(msg.sender, initialSupply);
    }

    // -----------------------------------------------------------------------
    // Vulnerability 4: no access control — any caller can mint to themselves
    // -----------------------------------------------------------------------
    function mint(uint256 amount) external {
        _mint(msg.sender, amount);
    }

    // -----------------------------------------------------------------------
    // Vulnerability 2: tx.origin authentication
    // A malicious contract can trick the original sender into an indirect call
    // and pass this check, draining their tokens.
    // -----------------------------------------------------------------------
    function transfer(address to, uint256 amount) external returns (bool) {
        require(tx.origin == msg.sender || allowance[tx.origin][msg.sender] >= amount,
            "InsecureToken: not authorised");
        _transfer(tx.origin, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "InsecureToken: allowance exceeded");
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    // -----------------------------------------------------------------------
    // Vulnerability 1: reentrancy — balance decremented AFTER external call
    // An attacker implementing onTokenBurn() can re-enter and burn again.
    // -----------------------------------------------------------------------
    function burnFrom(address from, uint256 amount) external {
        require(allowance[from][msg.sender] >= amount, "InsecureToken: allowance exceeded");
        require(balanceOf[from] >= amount, "InsecureToken: insufficient balance");

        allowance[from][msg.sender] -= amount;

        // External call BEFORE state update — reentrancy vector
        (bool ok, ) = from.call(abi.encodeWithSignature("onTokenBurn(uint256)", amount));
        // Vulnerability 3: return value ok is silently discarded
        ok;

        balanceOf[from] -= amount;  // state updated AFTER external call
        totalSupply -= amount;
        emit Burned(from, amount);
    }

    // -----------------------------------------------------------------------
    // Vulnerability 5: owner can forcibly burn tokens from any account
    // with no upper bound — complete centralisation risk
    // -----------------------------------------------------------------------
    function forceBurn(address target, uint256 amount) external {
        require(msg.sender == owner, "InsecureToken: not owner");
        require(balanceOf[target] >= amount, "InsecureToken: insufficient balance");
        balanceOf[target] -= amount;
        totalSupply -= amount;
        emit Burned(target, amount);
    }

    // -----------------------------------------------------------------------
    // Vulnerability 3: notifyReceiver makes a low-level call and ignores
    // the return value entirely — silent failures pass undetected
    // -----------------------------------------------------------------------
    function notifyReceiver(address receiver, bytes calldata data) external {
        // No return value check
        receiver.call(data);
    }

    // ---- Internal helpers ----

    function _transfer(address from, address to, uint256 amount) internal {
        // Vulnerability 6: no address(0) guard on either side
        require(balanceOf[from] >= amount, "InsecureToken: insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply    += amount;
        balanceOf[to]  += amount;
        emit Minted(to, amount);
        emit Transfer(address(0), to, amount);
    }
}
