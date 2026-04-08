// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC721Minimal {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function isApprovedForAll(address owner_, address operator) external view returns (bool);
}

/// @title InsecureMarketplace
/// @notice Simple NFT listing/buying marketplace with intentional security weaknesses
///         for static-analysis testing purposes.
/// @dev INTENTIONALLY VULNERABLE — do not use in production.
///
/// Vulnerabilities baked in:
///   1. Reentrancy in buyItem()           — ETH sent to seller BEFORE listing removed
///   2. tx.origin seller authentication   — malicious contract can list on behalf of real owner
///   3. Unchecked return value            — NFT transferFrom() return not verified
///   4. Price of 0 accepted              — no minimum price validation in listItem()
///   5. Fee truncation to zero           — 0.1% fee on small sales rounds to 0
///   6. Unprotected fee withdrawal       — withdrawFees() callable by anyone
///   7. Griefing via front-run cancel    — no lock after purchase intent
///   8. Missing indexed event fields     — hard to filter listings off-chain
contract InsecureMarketplace {
    struct Listing {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 price;     // wei
        bool    active;
    }

    address public feeRecipient;
    uint256 public accumulatedFees;
    uint256 public listingCount;
    uint256 public constant FEE_BPS = 10; // 0.10%

    mapping(uint256 => Listing) public listings;

    // Vulnerability 8: no indexed fields on price or nftContract
    event ItemListed(uint256 listingId, address seller, address nftContract, uint256 tokenId, uint256 price);
    event ItemSold(uint256 listingId, address buyer, uint256 price);
    event ListingCancelled(uint256 listingId);
    event FeesWithdrawn(address recipient, uint256 amount);

    constructor() {
        feeRecipient = msg.sender;
    }

    /// @notice Lists an NFT for sale.
    /// @param nftContract ERC721 contract address.
    /// @param tokenId Token ID to list.
    /// @param price Sale price in wei.
    function listItem(address nftContract, uint256 tokenId, uint256 price) external returns (uint256 id) {
        // Vulnerability 2: tx.origin check — a malicious intermediate contract can list
        // on behalf of the real NFT owner without their active consent in this call
        require(
            IERC721Minimal(nftContract).ownerOf(tokenId) == tx.origin,
            "InsecureMarketplace: not token owner"
        );

        // Vulnerability 4: price of 0 is accepted — NFT can be listed for free
        // allowing griefing or accidental giveaways

        id = ++listingCount;
        listings[id] = Listing({
            seller:      tx.origin,   // Vulnerability 2: records tx.origin, not msg.sender
            nftContract: nftContract,
            tokenId:     tokenId,
            price:       price,
            active:      true
        });

        emit ItemListed(id, tx.origin, nftContract, tokenId, price);
    }

    /// @notice Purchases a listed NFT.
    /// @param listingId ID of the listing to buy.
    function buyItem(uint256 listingId) external payable {
        Listing storage listing = listings[listingId];
        require(listing.active, "InsecureMarketplace: listing not active");
        require(msg.value >= listing.price, "InsecureMarketplace: insufficient payment");

        address seller = listing.seller;
        uint256 price  = listing.price;

        // Vulnerability 5: fee truncates to 0 for prices below 10_000 wei
        uint256 fee     = (price * FEE_BPS) / 10_000;
        uint256 payment = price - fee;
        accumulatedFees += fee;

        // Vulnerability 1: listing still active during the external ETH call
        // A malicious seller contract can re-enter buyItem() for the same listingId
        (bool sent, ) = payable(seller).call{value: payment}("");
        require(sent, "InsecureMarketplace: seller payment failed");

        // Listing deactivated AFTER external call — reentrancy window above
        listing.active = false;

        // Vulnerability 3: transferFrom return value not checked
        // If the transfer silently fails the buyer paid but received nothing
        IERC721Minimal(listing.nftContract).transferFrom(seller, msg.sender, listing.tokenId);

        // Refund overpayment — second external call after state change is also reentrancy-adjacent
        if (msg.value > price) {
            (bool refunded, ) = payable(msg.sender).call{value: msg.value - price}("");
            require(refunded, "InsecureMarketplace: refund failed");
        }

        emit ItemSold(listingId, msg.sender, price);
    }

    /// @notice Cancels an active listing.
    function cancelListing(uint256 listingId) external {
        Listing storage listing = listings[listingId];
        require(listing.active, "InsecureMarketplace: not active");
        // Vulnerability 7: anyone can cancel any listing — no seller-only guard
        listing.active = false;
        emit ListingCancelled(listingId);
    }

    /// @notice Withdraws accumulated fees.
    /// Vulnerability 6: no access control — any caller can drain fees to feeRecipient
    function withdrawFees() external {
        uint256 amount = accumulatedFees;
        require(amount > 0, "InsecureMarketplace: no fees");
        accumulatedFees = 0;
        (bool sent, ) = payable(feeRecipient).call{value: amount}("");
        require(sent, "InsecureMarketplace: fee withdrawal failed");
        emit FeesWithdrawn(feeRecipient, amount);
    }

    /// @notice Updates the fee recipient address. No access control.
    /// @param newRecipient New recipient address.
    function setFeeRecipient(address newRecipient) external {
        // Vulnerability 6 extension: no owner check — anyone can redirect fees
        require(newRecipient != address(0), "InsecureMarketplace: zero address");
        feeRecipient = newRecipient;
    }
}
