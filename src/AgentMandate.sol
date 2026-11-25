// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Mini, IERC3009} from "./IERC3009.sol";

/// @title AgentMandate
/// @notice A spending mandate for an AI agent, enforced by the contract itself.
///
///         The owner funds this contract with tUSD8 and sets the rules once:
///         a total cap, a per-payment cap, a payee allowlist and an expiry.
///         The agent can then pay invoices ONLY inside those rules. The agent
///         never touches a wallet key on chain: it signs an EIP-712
///         PaymentOrder off-chain and any relayer submits it, so the agent
///         needs no gas token at all (the gasless pattern: signed intent,
///         relayed execution, contract-enforced limits).
///
///         The owner can revoke the mandate instantly; after revocation every
///         payment reverts. Every payment emits an event, so the mandate has
///         a complete on-chain audit trail.
///
/// @dev One mandate per deployment keeps the rules easy to audit. Deploy a
///      fresh contract per agent / budget period.
contract AgentMandate {
    // ------------------------------------------------------------------ types

    struct PaymentOrder {
        bytes32 invoiceId;
        address payee;
        uint256 amount;
        uint256 nonce;
    }

    // ------------------------------------------------------------ EIP-712 data

    bytes32 public constant PAYMENT_ORDER_TYPEHASH =
        keccak256("PaymentOrder(bytes32 invoiceId,address payee,uint256 amount,uint256 nonce)");

    bytes32 private immutable _domainSeparator;

    // ------------------------------------------------------------------ state

    IERC20Mini public immutable token;
    address public immutable owner;
    address public immutable agent;

    uint256 public immutable totalCap;
    uint256 public immutable perPaymentCap;
    uint64 public immutable expiresAt;

    uint256 public spent;
    uint256 public agentNonce;
    bool public revoked;

    mapping(address payee => bool allowed) public isPayee;
    mapping(bytes32 invoiceId => bool paid) public invoicePaid;

    // ----------------------------------------------------------------- events

    event MandateFunded(address indexed from, uint256 amount, bool viaAuthorization);
    event InvoicePaid(bytes32 indexed invoiceId, address indexed payee, uint256 amount, uint256 totalSpent);
    event MandateRevoked(address indexed owner);
    event PayeeUpdated(address indexed payee, bool allowed);
    event FundsWithdrawn(address indexed to, uint256 amount);

    // ----------------------------------------------------------------- errors

    error NotOwner();
    error NotAgent();
    error MandateRevokedError();
    error MandateExpired();
    error MandateNotExpired();
    error PayeeNotAllowed(address payee);
    error OverPerPaymentCap(uint256 amount, uint256 cap);
    error OverTotalCap(uint256 newSpent, uint256 cap);
    error InvoiceAlreadyPaid(bytes32 invoiceId);
    error BadNonce(uint256 expected, uint256 got);
    error BadAgentSignature();
    error ZeroAmount();
    error ZeroAddress();
    error TransferFailed();

    // ------------------------------------------------------------ constructor

    constructor(
        address token_,
        address agent_,
        uint256 totalCap_,
        uint256 perPaymentCap_,
        uint64 expiresAt_,
        address[] memory payees_
    ) {
        if (token_ == address(0) || agent_ == address(0)) revert ZeroAddress();
        if (totalCap_ == 0 || perPaymentCap_ == 0 || perPaymentCap_ > totalCap_) revert ZeroAmount();
        token = IERC20Mini(token_);
        owner = msg.sender;
        agent = agent_;
        totalCap = totalCap_;
        perPaymentCap = perPaymentCap_;
        expiresAt = expiresAt_;
        for (uint256 i = 0; i < payees_.length; i++) {
            if (payees_[i] == address(0)) revert ZeroAddress();
            isPayee[payees_[i]] = true;
            emit PayeeUpdated(payees_[i], true);
        }
        _domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("AgentPay Mandate")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // ---------------------------------------------------------------- funding

    /// @notice Fund the mandate from the owner's wallet (approve first).
    function fund(uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        if (amount == 0) revert ZeroAmount();
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit MandateFunded(msg.sender, amount, false);
    }

    /// @notice Fund the mandate gaslessly: the owner signs an EIP-3009
    ///         ReceiveWithAuthorization off-chain and ANY relayer submits it.
    ///         The owner needs no native gas token for this call.
    /// @dev The signed `to` must be this contract; tUSD8 enforces that the
    ///      caller of receiveWithAuthorization is the payee, which is exactly
    ///      this contract when it pulls the authorization in.
    function fundWithAuthorization(
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (value == 0) revert ZeroAmount();
        IERC3009(address(token)).receiveWithAuthorization(
            from, address(this), value, validAfter, validBefore, nonce, v, r, s
        );
        emit MandateFunded(from, value, true);
    }

    // ---------------------------------------------------------------- payment

    /// @notice Execute one invoice payment ordered by the agent.
    /// @dev Callable by anyone (a relayer). The agent only signs off-chain.
    ///      Checks run in a fixed order so rejections are unambiguous:
    ///      revoked -> expired -> already paid -> nonce -> signature ->
    ///      allowlist -> per-payment cap -> total cap.
    function executePayment(PaymentOrder calldata order, uint8 v, bytes32 r, bytes32 s) external {
        if (revoked) revert MandateRevokedError();
        if (block.timestamp >= expiresAt) revert MandateExpired();
        if (order.amount == 0) revert ZeroAmount();
        if (invoicePaid[order.invoiceId]) revert InvoiceAlreadyPaid(order.invoiceId);
        if (order.nonce != agentNonce) revert BadNonce(agentNonce, order.nonce);
        if (_recoverSigner(order, v, r, s) != agent) revert BadAgentSignature();
        if (!isPayee[order.payee]) revert PayeeNotAllowed(order.payee);
        if (order.amount > perPaymentCap) revert OverPerPaymentCap(order.amount, perPaymentCap);
        uint256 newSpent = spent + order.amount;
        if (newSpent > totalCap) revert OverTotalCap(newSpent, totalCap);

        invoicePaid[order.invoiceId] = true;
        spent = newSpent;
        agentNonce = order.nonce + 1;

        if (!token.transfer(order.payee, order.amount)) revert TransferFailed();
        emit InvoicePaid(order.invoiceId, order.payee, order.amount, newSpent);
    }

    // ------------------------------------------------------------- owner admin

    /// @notice Instantly revoke the mandate. Every later payment reverts.
    function revoke() external {
        if (msg.sender != owner) revert NotOwner();
        revoked = true;
        emit MandateRevoked(msg.sender);
    }

    /// @notice Add or remove a payee on the allowlist.
    function setPayee(address payee, bool allowed) external {
        if (msg.sender != owner) revert NotOwner();
        if (payee == address(0)) revert ZeroAddress();
        isPayee[payee] = allowed;
        emit PayeeUpdated(payee, allowed);
    }

    /// @notice Withdraw unspent funds back to the owner.
    function withdraw(uint256 amount, address to) external {
        if (msg.sender != owner) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();
        if (!token.transfer(to, amount)) revert TransferFailed();
        emit FundsWithdrawn(to, amount);
    }

    // ------------------------------------------------------------------ views

    /// @notice tUSD8 still available to the agent under this mandate.
    function remaining() external view returns (uint256) {
        uint256 capLeft = totalCap - spent;
        uint256 balance = token.balanceOf(address(this));
        return capLeft < balance ? capLeft : balance;
    }

    /// @notice True while the agent may still pay: funded rules, not revoked, not expired.
    function isActive() external view returns (bool) {
        return !revoked && block.timestamp < expiresAt;
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparator;
    }

    /// @notice The exact digest the agent must sign for `order`.
    function paymentOrderDigest(PaymentOrder calldata order) external view returns (bytes32) {
        return _digest(order);
    }

    // --------------------------------------------------------------- internal

    function _digest(PaymentOrder calldata order) internal view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(PAYMENT_ORDER_TYPEHASH, order.invoiceId, order.payee, order.amount, order.nonce));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
    }

    function _recoverSigner(PaymentOrder calldata order, uint8 v, bytes32 r, bytes32 s) internal view returns (address) {
        // Reject malleable signatures (EIP-2 style bound, same rule OpenZeppelin uses).
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(_digest(order), v, r, s);
    }
}
