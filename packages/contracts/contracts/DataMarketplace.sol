// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";
import {IHederaTokenService} from "./interfaces/IHederaTokenService.sol";

/// @title AuditGuard Data Marketplace
/// @notice Enables agent-to-agent information trading with on-chain payment/access control.
contract DataMarketplace is Ownable, ReentrancyGuard {
    /// @notice Hedera Token Service precompile address.
    IHederaTokenService internal constant HTS = IHederaTokenService(address(0x167));

    /// @dev Hedera response code for successful HTS call.
    int64 internal constant HTS_SUCCESS = 22;

    /// @notice Listing sale model.
    enum ListingType {
        ONE_TIME,
        SUBSCRIPTION,
        TIP
    }

    /// @notice Category for data product discovery/filtering.
    enum DataCategory {
        SCAN_REPORT,
        DEPENDENCY_ANALYSIS,
        EXPLOIT_DATABASE,
        HOT_LEAD,
        FUZZING_SEEDS,
        THREAT_INTEL,
        AUDIT_FINDING,
        OTHER
    }

    /// @notice Listing lifecycle status.
    enum ListingStatus {
        ACTIVE,
        SOLD_OUT,
        EXPIRED,
        DELISTED
    }

    /// @notice Metadata and commercial state for a data listing.
    struct DataListing {
        uint256 listingId;
        address seller;
        uint256 parentJobId;
        string title;
        string description;
        DataCategory category;
        ListingType listingType;
        uint256 price;
        uint256 subscriptionPeriod;
        bytes32 contentHash;
        uint256 maxBuyers;
        uint256 buyerCount;
        uint256 listedAt;
        uint256 expiresAt;
        ListingStatus status;
        uint256 totalRevenue;
    }

    /// @notice Purchase/payment record tied to a listing and buyer.
    struct Purchase {
        uint256 purchaseId;
        uint256 listingId;
        address buyer;
        uint256 pricePaid;
        uint256 purchasedAt;
        uint256 subscriptionExpiresAt;
        bool accessGranted;
        uint8 rating;
    }

    /// @notice GUARD token EVM address.
    address public guardToken;

    /// @notice AgentRegistry contract address.
    address public agentRegistry;

    /// @notice Treasury recipient for marketplace platform fees.
    address public treasury;

    /// @notice Default marketplace fee percent.
    uint256 public platformFeePercent = 3;

    /// @notice Auto-incrementing listing id counter (starts at 1).
    uint256 public nextListingId;

    /// @notice Auto-incrementing purchase id counter (starts at 1).
    uint256 public nextPurchaseId;

    /// @notice Reputation threshold for discounted seller platform fee.
    uint256 public constant HIGH_REP_DISCOUNT_THRESHOLD = 8500;

    /// @notice Reduced fee percent for high-reputation sellers.
    uint256 public constant HIGH_REP_FEE_PERCENT = 1;

    /// @notice Listing storage by id.
    mapping(uint256 => DataListing) internal listings;

    /// @dev Purchase history grouped by listing id.
    mapping(uint256 => Purchase[]) internal _purchases;

    /// @notice Listing ids created by each seller.
    mapping(address => uint256[]) public sellerListings;

    /// @notice Purchase ids created by each buyer.
    mapping(address => uint256[]) public buyerPurchases;

    /// @notice Quick lookup for purchased access.
    mapping(uint256 => mapping(address => bool)) public hasBuyerAccess;

    /// @notice Parent job to listing ids mapping for iNFT lineage.
    mapping(uint256 => uint256[]) public jobListings;

    /// @notice Emitted when a seller publishes a new data listing.
    event DataListed(
        uint256 indexed listingId,
        address indexed seller,
        uint256 parentJobId,
        string title,
        DataCategory category,
        ListingType listingType,
        uint256 price,
        bytes32 contentHash
    );

    /// @notice Emitted when a buyer purchases listing access.
    event DataPurchased(
        uint256 indexed listingId,
        address indexed buyer,
        address indexed seller,
        uint256 pricePaid,
        uint256 platformFee
    );

    /// @notice Emitted when a subscriber renews paid access.
    event SubscriptionRenewed(uint256 indexed listingId, address indexed buyer, uint256 newExpiresAt);

    /// @notice Emitted when a buyer tips a seller.
    event TipSent(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 amount);

    /// @notice Emitted when a buyer rates purchased data.
    event DataRated(uint256 indexed listingId, address indexed buyer, uint8 rating);

    /// @notice Emitted when seller delists a listing.
    event DataDelisted(uint256 indexed listingId);

    /// @notice Emitted when seller updates listing price.
    event PriceUpdated(uint256 indexed listingId, uint256 oldPrice, uint256 newPrice);

    /// @notice [Frontend] Deploys data marketplace with day-1 registry/token dependencies.
    /// @param _guardToken GUARD token EVM address.
    /// @param _agentRegistry AgentRegistry contract address.
    /// @param _treasury Treasury address for marketplace fee routing.
    constructor(address _guardToken, address _agentRegistry, address _treasury) Ownable(msg.sender) {
        require(_guardToken != address(0), "DataMarketplace: guard token is zero");
        require(_agentRegistry != address(0), "DataMarketplace: registry is zero");
        require(_treasury != address(0), "DataMarketplace: treasury is zero");

        guardToken = _guardToken;
        agentRegistry = _agentRegistry;
        treasury = _treasury;
        nextListingId = 1;
        nextPurchaseId = 1;
    }

    /// @notice [Agent Systems] Agents call this to list data products.
    /// @notice [iNFT] parentJobId links this listing to the job's iNFT state.
    /// @notice [Frontend] DataListed event feeds the marketplace feed on dashboard.
    /// @param parentJobId Parent AuditAuction job id, or 0 for standalone data.
    /// @param title Listing title.
    /// @param description Listing description.
    /// @param category Data category tag.
    /// @param listingType Commercial listing type.
    /// @param price GUARD price for purchase cycle.
    /// @param subscriptionPeriod Period in seconds for subscriptions, else 0.
    /// @param contentHash Off-chain payload hash anchor.
    /// @param maxBuyers Maximum buyers allowed (0 means unlimited).
    /// @param durationSeconds Listing lifetime in seconds (0 means never expires).
    /// @return listingId Newly created listing id.
    function createListing(
        uint256 parentJobId,
        string calldata title,
        string calldata description,
        DataCategory category,
        ListingType listingType,
        uint256 price,
        uint256 subscriptionPeriod,
        bytes32 contentHash,
        uint256 maxBuyers,
        uint256 durationSeconds
    ) external returns (uint256 listingId) {
        _requireActiveAgent(msg.sender);
        _validateListingInput(title, description, listingType, subscriptionPeriod, contentHash);

        listingId = nextListingId;
        nextListingId += 1;

        DataListing storage listing = listings[listingId];
        listing.listingId = listingId;
        listing.seller = msg.sender;
        listing.parentJobId = parentJobId;
        listing.title = title;
        listing.description = description;
        listing.category = category;
        listing.listingType = listingType;
        listing.price = price;
        listing.subscriptionPeriod = subscriptionPeriod;
        listing.contentHash = contentHash;
        listing.maxBuyers = maxBuyers;
        listing.listedAt = block.timestamp;
        listing.expiresAt = durationSeconds > 0 ? block.timestamp + durationSeconds : 0;
        listing.status = ListingStatus.ACTIVE;

        sellerListings[msg.sender].push(listingId);
        jobListings[parentJobId].push(listingId);

        _emitDataListed(listingId);
    }

    /// @notice [Agent Systems] Agents purchase listing access and settle payment in GUARD.
    /// @notice [Frontend] DataPurchased drives transaction history and revenue UI.
    /// @param listingId Listing id to purchase.
    function purchaseData(uint256 listingId) external nonReentrant {
        _requireActiveAgent(msg.sender);

        DataListing storage listing = _getExistingListing(listingId);
        _requirePurchasableListing(listing);
        require(msg.sender != listing.seller, "DataMarketplace: seller cannot buy own listing");

        if (listing.listingType != ListingType.SUBSCRIPTION) {
            require(!hasBuyerAccess[listingId][msg.sender], "DataMarketplace: buyer already has access");
        }

        uint256 platformFee = _processSalePayment(msg.sender, listing.seller, listing.price);
        uint256 purchaseId = _createPurchaseRecord(listing, listingId, msg.sender);

        listing.buyerCount += 1;
        listing.totalRevenue += listing.price;
        hasBuyerAccess[listingId][msg.sender] = true;
        buyerPurchases[msg.sender].push(purchaseId);

        if (listing.maxBuyers > 0 && listing.buyerCount >= listing.maxBuyers) {
            listing.status = ListingStatus.SOLD_OUT;
        }

        emit DataPurchased(listingId, msg.sender, listing.seller, listing.price, platformFee);
    }

    /// @notice [Agent Systems] Renews subscription access by processing another payment cycle.
    /// @notice [Frontend] SubscriptionRenewed updates access-expiry indicators in marketplace UI.
    /// @param listingId Subscription listing id.
    function renewSubscription(uint256 listingId) external nonReentrant {
        _requireActiveAgent(msg.sender);

        DataListing storage listing = _getExistingListing(listingId);
        _requirePurchasableListing(listing);
        require(listing.listingType == ListingType.SUBSCRIPTION, "DataMarketplace: listing is not subscription");
        require(hasBuyerAccess[listingId][msg.sender], "DataMarketplace: buyer has no prior purchase");

        _processSalePayment(msg.sender, listing.seller, listing.price);

        (bool found, uint256 index) = _findLatestPurchaseIndex(listingId, msg.sender);
        require(found, "DataMarketplace: purchase not found");

        Purchase storage purchase = _purchases[listingId][index];
        uint256 baseTimestamp = purchase.subscriptionExpiresAt > block.timestamp
            ? purchase.subscriptionExpiresAt
            : block.timestamp;
        purchase.subscriptionExpiresAt = baseTimestamp + listing.subscriptionPeriod;
        purchase.pricePaid = listing.price;
        purchase.purchasedAt = block.timestamp;
        purchase.accessGranted = true;

        listing.totalRevenue += listing.price;

        emit SubscriptionRenewed(listingId, msg.sender, purchase.subscriptionExpiresAt);
    }

    /// @notice [Agent Systems] Sends a direct no-fee tip from buyer to seller.
    /// @notice [Frontend] TipSent supports social/reward activity feeds.
    /// @param listingId Listing id whose seller receives the tip.
    /// @param amount Tip amount in GUARD smallest units.
    function tipSeller(uint256 listingId, uint256 amount) external nonReentrant {
        _requireActiveAgent(msg.sender);
        require(amount > 0, "DataMarketplace: amount is zero");

        DataListing storage listing = _getExistingListing(listingId);
        require(msg.sender != listing.seller, "DataMarketplace: seller cannot tip self");

        _transferGuard(msg.sender, listing.seller, amount);

        emit TipSent(listingId, msg.sender, listing.seller, amount);
    }

    /// @notice [Agent Systems] Buyers rate purchased data quality on a 1-5 scale.
    /// @notice [iNFT] Ratings can be aggregated into agent quality metadata.
    /// @notice [Frontend] DataRated enables reputation badges and listing quality signals.
    /// @param listingId Listing id being rated.
    /// @param rating Integer rating from 1 to 5.
    function ratePurchase(uint256 listingId, uint8 rating) external {
        require(rating >= 1 && rating <= 5, "DataMarketplace: rating must be 1-5");
        require(hasBuyerAccess[listingId][msg.sender], "DataMarketplace: buyer has no access");

        _getExistingListing(listingId);
        (bool found, uint256 index) = _findLatestPurchaseIndex(listingId, msg.sender);
        require(found, "DataMarketplace: purchase not found");

        _purchases[listingId][index].rating = rating;

        emit DataRated(listingId, msg.sender, rating);
    }

    /// @notice [Agent Systems] Seller delists an offer while preserving existing buyer access.
    /// @notice [Frontend] DataDelisted removes listing from active marketplace surfaces.
    /// @param listingId Listing id to delist.
    function delistData(uint256 listingId) external {
        DataListing storage listing = _getExistingListing(listingId);
        require(msg.sender == listing.seller, "DataMarketplace: caller is not seller");

        listing.status = ListingStatus.DELISTED;

        emit DataDelisted(listingId);
    }

    /// @notice [Agent Systems] Seller updates listing price to support dynamic data pricing.
    /// @notice [Frontend] PriceUpdated refreshes listing cards/orderbook values.
    /// @param listingId Listing id to update.
    /// @param newPrice New listing price.
    function updatePrice(uint256 listingId, uint256 newPrice) external {
        DataListing storage listing = _getExistingListing(listingId);
        require(msg.sender == listing.seller, "DataMarketplace: caller is not seller");
        require(listing.status == ListingStatus.ACTIVE, "DataMarketplace: listing not active");
        require(!_isExpired(listing), "DataMarketplace: listing expired");

        uint256 oldPrice = listing.price;
        listing.price = newPrice;

        emit PriceUpdated(listingId, oldPrice, newPrice);
    }

    /// @notice [Frontend] Returns complete listing payload by id.
    /// @param listingId Listing id.
    /// @return listing Data listing payload.
    function getListing(uint256 listingId) external view returns (DataListing memory listing) {
        listing = _getExistingListing(listingId);
    }

    /// @notice [Frontend] Returns purchase history for a given listing.
    /// @param listingId Listing id.
    /// @return purchases Purchase records for this listing.
    function getPurchases(uint256 listingId) external view returns (Purchase[] memory purchases) {
        _getExistingListing(listingId);
        return _purchases[listingId];
    }

    /// @notice [Agent Systems] Returns listing ids filtered by category.
    /// @param category Category filter.
    /// @return listingIds Listing ids matching `category`.
    function getListingsByCategory(DataCategory category) external view returns (uint256[] memory listingIds) {
        uint256 count = 0;
        for (uint256 id = 1; id < nextListingId; id++) {
            if (listings[id].category == category) {
                count++;
            }
        }

        listingIds = new uint256[](count);
        uint256 cursor = 0;
        for (uint256 id = 1; id < nextListingId; id++) {
            if (listings[id].category == category) {
                listingIds[cursor] = id;
                cursor++;
            }
        }
    }

    /// @notice [iNFT] Returns listing ids linked to a parent audit job.
    /// @param parentJobId Parent job id.
    /// @return listingIds Listing ids linked to this parent job.
    function getListingsForJob(uint256 parentJobId) external view returns (uint256[] memory listingIds) {
        return jobListings[parentJobId];
    }

    /// @notice [Frontend] Returns listing ids created by a seller.
    /// @param seller Seller address.
    /// @return listingIds Listing ids by seller.
    function getSellerListings(address seller) external view returns (uint256[] memory listingIds) {
        return sellerListings[seller];
    }

    /// @notice [Frontend] Returns purchase ids created by a buyer.
    /// @param buyer Buyer address.
    /// @return purchaseIds Purchase ids by buyer.
    function getBuyerPurchases(address buyer) external view returns (uint256[] memory purchaseIds) {
        return buyerPurchases[buyer];
    }

    /// @notice [Agent Systems] Quick access lookup for whether a buyer has purchased listing access.
    /// @param listingId Listing id.
    /// @param buyer Buyer address.
    /// @return granted True if buyer has purchased access at least once.
    function hasAccess(uint256 listingId, address buyer) external view returns (bool granted) {
        _getExistingListing(listingId);
        return hasBuyerAccess[listingId][buyer];
    }

    /// @notice [Agent Systems] Checks whether a buyer currently has active subscription entitlement.
    /// @param listingId Listing id.
    /// @param buyer Buyer address.
    /// @return active True if a subscription purchase exists and is not expired.
    function isSubscriptionActive(uint256 listingId, address buyer) external view returns (bool active) {
        DataListing storage listing = _getExistingListing(listingId);
        if (listing.listingType != ListingType.SUBSCRIPTION || !hasBuyerAccess[listingId][buyer]) {
            return false;
        }

        (bool found, uint256 index) = _findLatestPurchaseIndex(listingId, buyer);
        if (!found) {
            return false;
        }

        return _purchases[listingId][index].subscriptionExpiresAt > block.timestamp;
    }

    /// @notice [Frontend] Returns all listing ids that are currently ACTIVE and unexpired.
    /// @return listingIds Active listing ids.
    function getActiveListings() external view returns (uint256[] memory listingIds) {
        uint256 count = 0;
        for (uint256 id = 1; id < nextListingId; id++) {
            DataListing storage listing = listings[id];
            if (listing.status == ListingStatus.ACTIVE && !_isExpired(listing)) {
                count++;
            }
        }

        listingIds = new uint256[](count);
        uint256 cursor = 0;
        for (uint256 id = 1; id < nextListingId; id++) {
            DataListing storage listing = listings[id];
            if (listing.status == ListingStatus.ACTIVE && !_isExpired(listing)) {
                listingIds[cursor] = id;
                cursor++;
            }
        }
    }

    /// @notice [Frontend] Returns average non-zero rating and rating count for a listing.
    /// @param listingId Listing id.
    /// @return avg Average rating value (integer, floor division).
    /// @return count Number of ratings included in average.
    function getAverageRating(uint256 listingId) external view returns (uint256 avg, uint256 count) {
        _getExistingListing(listingId);
        Purchase[] storage records = _purchases[listingId];
        uint256 sum = 0;
        for (uint256 i = 0; i < records.length; i++) {
            uint8 score = records[i].rating;
            if (score > 0) {
                sum += score;
                count++;
            }
        }

        if (count == 0) {
            return (0, 0);
        }
        avg = sum / count;
    }

    /// @notice [Frontend] Updates marketplace treasury address.
    /// @param _treasury New treasury address.
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "DataMarketplace: treasury is zero");
        treasury = _treasury;
    }

    /// @notice [Frontend] Updates default platform fee percent (max 10%).
    /// @param feePercent New fee percent.
    function setPlatformFeePercent(uint256 feePercent) external onlyOwner {
        require(feePercent <= 10, "DataMarketplace: fee exceeds maximum");
        platformFeePercent = feePercent;
    }

    /// @notice [Frontend] Updates AgentRegistry dependency used for active-agent checks.
    /// @param _agentRegistry New AgentRegistry contract address.
    function setAgentRegistry(address _agentRegistry) external onlyOwner {
        require(_agentRegistry != address(0), "DataMarketplace: registry is zero");
        agentRegistry = _agentRegistry;
    }

    /// @notice [Agent Systems] Ensures caller is an active registered agent.
    /// @param agent Address to verify.
    function _requireActiveAgent(address agent) internal view {
        require(IAgentRegistry(agentRegistry).isActiveAgent(agent), "DataMarketplace: inactive agent");
    }

    /// @notice [Frontend] Returns listing storage reference or reverts if missing.
    /// @param listingId Listing id.
    /// @return listing Listing storage reference.
    function _getExistingListing(uint256 listingId) internal view returns (DataListing storage listing) {
        listing = listings[listingId];
        require(listing.listingId != 0, "DataMarketplace: listing does not exist");
    }

    /// @notice [Agent Systems] Enforces listing can be purchased/renewed.
    /// @param listing Listing to validate.
    function _requirePurchasableListing(DataListing storage listing) internal view {
        require(listing.status == ListingStatus.ACTIVE, "DataMarketplace: listing not active");
        require(!_isExpired(listing), "DataMarketplace: listing expired");
        if (listing.maxBuyers > 0) {
            require(listing.buyerCount < listing.maxBuyers, "DataMarketplace: listing sold out");
        }
    }

    /// @notice [Frontend] Returns whether listing has crossed expiry timestamp.
    /// @param listing Listing payload.
    /// @return expired True when listing has finite expiry and timestamp has passed.
    function _isExpired(DataListing storage listing) internal view returns (bool expired) {
        return listing.expiresAt != 0 && block.timestamp > listing.expiresAt;
    }

    /// @notice [Agent Systems] Finds latest purchase record for a buyer within a listing.
    /// @param listingId Listing id.
    /// @param buyer Buyer address.
    /// @return found True if buyer purchase exists.
    /// @return index Array index of latest purchase.
    function _findLatestPurchaseIndex(uint256 listingId, address buyer)
        internal
        view
        returns (bool found, uint256 index)
    {
        Purchase[] storage records = _purchases[listingId];
        for (uint256 i = records.length; i > 0; i--) {
            if (records[i - 1].buyer == buyer) {
                return (true, i - 1);
            }
        }
        return (false, 0);
    }

    /// @notice [Agent Systems] Computes seller fee tier and payment split.
    /// @param seller Seller address.
    /// @param price Listing price.
    /// @return feePercent Applied fee percent.
    /// @return platformFee Fee amount paid to treasury.
    /// @return sellerPayment Net amount paid to seller.
    function _feeBreakdown(address seller, uint256 price)
        internal
        view
        returns (uint256 feePercent, uint256 platformFee, uint256 sellerPayment)
    {
        uint256 reputation = IAgentRegistry(agentRegistry).getAgentReputation(seller);
        feePercent = reputation >= HIGH_REP_DISCOUNT_THRESHOLD ? HIGH_REP_FEE_PERCENT : platformFeePercent;
        platformFee = (price * feePercent) / 100;
        sellerPayment = price - platformFee;
    }

    /// @notice [Agent Systems] Validates listing creation parameters.
    /// @param title Listing title.
    /// @param description Listing description.
    /// @param listingType Listing type.
    /// @param subscriptionPeriod Subscription period.
    /// @param contentHash Off-chain payload hash anchor.
    function _validateListingInput(
        string calldata title,
        string calldata description,
        ListingType listingType,
        uint256 subscriptionPeriod,
        bytes32 contentHash
    ) internal pure {
        require(bytes(title).length > 0, "DataMarketplace: empty title");
        require(bytes(description).length > 0, "DataMarketplace: empty description");
        require(contentHash != bytes32(0), "DataMarketplace: empty content hash");
        if (listingType == ListingType.SUBSCRIPTION) {
            require(subscriptionPeriod > 0, "DataMarketplace: subscription period is zero");
        } else {
            require(subscriptionPeriod == 0, "DataMarketplace: non-subscription period must be zero");
        }
    }

    /// @notice [Frontend] Emits DataListed event from stored listing payload.
    /// @param listingId Listing id to emit.
    function _emitDataListed(uint256 listingId) internal {
        DataListing storage listing = listings[listingId];
        emit DataListed(
            listing.listingId,
            listing.seller,
            listing.parentJobId,
            listing.title,
            listing.category,
            listing.listingType,
            listing.price,
            listing.contentHash
        );
    }

    /// @notice [Agent Systems] Processes paid listing settlement split between seller and treasury.
    /// @param buyer Buyer paying for listing access.
    /// @param seller Seller receiving net payout.
    /// @param price Listing price.
    /// @return platformFee Fee transferred to treasury.
    function _processSalePayment(address buyer, address seller, uint256 price) internal returns (uint256 platformFee) {
        uint256 sellerPayment;
        (, platformFee, sellerPayment) = _feeBreakdown(seller, price);
        if (price == 0) {
            return platformFee;
        }

        _transferGuard(buyer, address(this), price);
        if (sellerPayment > 0) {
            _transferGuard(address(this), seller, sellerPayment);
        }
        if (platformFee > 0) {
            _transferGuard(address(this), treasury, platformFee);
        }
    }

    /// @notice [Agent Systems] Appends purchase history record for buyer/listing pair.
    /// @param listing Listing payload.
    /// @param listingId Listing id.
    /// @param buyer Buyer address.
    /// @return purchaseId Newly assigned purchase id.
    function _createPurchaseRecord(DataListing storage listing, uint256 listingId, address buyer)
        internal
        returns (uint256 purchaseId)
    {
        purchaseId = nextPurchaseId;
        nextPurchaseId += 1;

        uint256 subscriptionExpiresAt = listing.listingType == ListingType.SUBSCRIPTION
            ? block.timestamp + listing.subscriptionPeriod
            : 0;

        _purchases[listingId].push(
            Purchase({
                purchaseId: purchaseId,
                listingId: listingId,
                buyer: buyer,
                pricePaid: listing.price,
                purchasedAt: block.timestamp,
                subscriptionExpiresAt: subscriptionExpiresAt,
                accessGranted: true,
                rating: 0
            })
        );
    }

    /// @notice [Agent Systems] Calls HTS precompile to transfer GUARD between accounts.
    /// @param from Sender address.
    /// @param to Receiver address.
    /// @param amount Amount in smallest GUARD units.
    function _transferGuard(address from, address to, uint256 amount) internal {
        require(amount <= uint256(uint64(type(int64).max)), "DataMarketplace: amount exceeds int64");
        int64 responseCode = HTS.transferToken(guardToken, from, to, int64(uint64(amount)));
        require(responseCode == HTS_SUCCESS, "DataMarketplace: HTS transfer failed");
    }
}
