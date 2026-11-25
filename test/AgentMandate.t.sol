// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentMandate} from "../src/AgentMandate.sol";
import {MockUSD8} from "../src/MockUSD8.sol";

contract AgentMandateTest is Test {
    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant AGENT_KEY = 0xA6E17;
    uint256 internal constant STRANGER_KEY = 0xBAD5;

    uint256 internal constant TOTAL_CAP = 100e6; // 100 tUSD8
    uint256 internal constant PER_PAY_CAP = 40e6; // 40 tUSD8

    MockUSD8 internal token;
    AgentMandate internal mandate;

    address internal owner;
    address internal agent;
    address internal relayer;
    address internal payee1;
    address internal payee2;
    address internal outsider;

    uint64 internal expiresAt;

    function setUp() public {
        vm.warp(1_700_000_000);
        owner = vm.addr(OWNER_KEY);
        agent = vm.addr(AGENT_KEY);
        relayer = makeAddr("relayer");
        payee1 = makeAddr("payee1");
        payee2 = makeAddr("payee2");
        outsider = makeAddr("outsider");

        token = new MockUSD8();
        token.mint(owner, 1_000e6);

        expiresAt = uint64(block.timestamp + 1 days);
        address[] memory payees = new address[](2);
        payees[0] = payee1;
        payees[1] = payee2;

        vm.prank(owner);
        mandate = new AgentMandate(address(token), agent, TOTAL_CAP, PER_PAY_CAP, expiresAt, payees);

        vm.startPrank(owner);
        token.approve(address(mandate), TOTAL_CAP);
        mandate.fund(TOTAL_CAP);
        vm.stopPrank();
    }

    // -------------------------------------------------------------- helpers

    function _order(bytes32 invoiceId, address payee, uint256 amount, uint256 nonce)
        internal
        pure
        returns (AgentMandate.PaymentOrder memory)
    {
        return AgentMandate.PaymentOrder({invoiceId: invoiceId, payee: payee, amount: amount, nonce: nonce});
    }

    function _sign(AgentMandate.PaymentOrder memory order, uint256 key) internal view returns (uint8, bytes32, bytes32) {
        return vm.sign(key, mandate.paymentOrderDigest(order));
    }

    function _pay(AgentMandate.PaymentOrder memory order) internal {
        (uint8 v, bytes32 r, bytes32 s) = _sign(order, AGENT_KEY);
        vm.prank(relayer); // a third party relays; the agent spends no gas
        mandate.executePayment(order, v, r, s);
    }

    // ---------------------------------------------------------------- tests

    function test_PayWithinLimits() public {
        _pay(_order(keccak256("inv-1"), payee1, 25e6, 0));
        assertEq(token.balanceOf(payee1), 25e6);
        assertEq(mandate.spent(), 25e6);
        assertEq(mandate.remaining(), 75e6);
        assertTrue(mandate.invoicePaid(keccak256("inv-1")));
        assertTrue(mandate.isActive());
    }

    function test_OverPerPaymentCapRejected() public {
        AgentMandate.PaymentOrder memory order = _order(keccak256("inv-big"), payee1, PER_PAY_CAP + 1, 0);
        (uint8 v, bytes32 r, bytes32 s) = _sign(order, AGENT_KEY);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.OverPerPaymentCap.selector, PER_PAY_CAP + 1, PER_PAY_CAP));
        vm.prank(relayer);
        mandate.executePayment(order, v, r, s);
        assertEq(token.balanceOf(payee1), 0);
    }

    function test_NonAllowlistedPayeeRejected() public {
        AgentMandate.PaymentOrder memory order = _order(keccak256("inv-out"), outsider, 10e6, 0);
        (uint8 v, bytes32 r, bytes32 s) = _sign(order, AGENT_KEY);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.PayeeNotAllowed.selector, outsider));
        vm.prank(relayer);
        mandate.executePayment(order, v, r, s);
    }

    function test_ExpiredMandateRejected() public {
        AgentMandate.PaymentOrder memory order = _order(keccak256("inv-late"), payee1, 10e6, 0);
        (uint8 v, bytes32 r, bytes32 s) = _sign(order, AGENT_KEY);
        vm.warp(expiresAt); // exactly at expiry: no longer active
        vm.expectRevert(AgentMandate.MandateExpired.selector);
        vm.prank(relayer);
        mandate.executePayment(order, v, r, s);
    }

    function test_AfterRevokeAllPaymentsRejected() public {
        vm.prank(owner);
        mandate.revoke();
        assertFalse(mandate.isActive());
        AgentMandate.PaymentOrder memory order = _order(keccak256("inv-rev"), payee1, 10e6, 0);
        (uint8 v, bytes32 r, bytes32 s) = _sign(order, AGENT_KEY);
        vm.expectRevert(AgentMandate.MandateRevokedError.selector);
        vm.prank(relayer);
        mandate.executePayment(order, v, r, s);
        assertEq(token.balanceOf(payee1), 0);
    }

    function test_TotalCapCannotBeExceededAcrossPayments() public {
        _pay(_order(keccak256("inv-a"), payee1, 40e6, 0));
        _pay(_order(keccak256("inv-b"), payee2, 40e6, 1));
        AgentMandate.PaymentOrder memory third = _order(keccak256("inv-c"), payee1, 30e6, 2);
        (uint8 v, bytes32 r, bytes32 s) = _sign(third, AGENT_KEY);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.OverTotalCap.selector, 110e6, TOTAL_CAP));
        vm.prank(relayer);
        mandate.executePayment(third, v, r, s);
        assertEq(mandate.spent(), 80e6);
    }

    function test_InvoiceCannotBePaidTwice() public {
        bytes32 invoiceId = keccak256("inv-dupe");
        _pay(_order(invoiceId, payee1, 10e6, 0));
        AgentMandate.PaymentOrder memory again = _order(invoiceId, payee1, 10e6, 1);
        (uint8 v, bytes32 r, bytes32 s) = _sign(again, AGENT_KEY);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.InvoiceAlreadyPaid.selector, invoiceId));
        vm.prank(relayer);
        mandate.executePayment(again, v, r, s);
        assertEq(token.balanceOf(payee1), 10e6);
    }

    function test_BadAgentSignatureRejected() public {
        AgentMandate.PaymentOrder memory order = _order(keccak256("inv-forged"), payee1, 10e6, 0);
        (uint8 v, bytes32 r, bytes32 s) = _sign(order, STRANGER_KEY);
        vm.expectRevert(AgentMandate.BadAgentSignature.selector);
        vm.prank(relayer);
        mandate.executePayment(order, v, r, s);
    }

    function test_BadNonceRejected() public {
        AgentMandate.PaymentOrder memory order = _order(keccak256("inv-nonce"), payee1, 10e6, 7);
        (uint8 v, bytes32 r, bytes32 s) = _sign(order, AGENT_KEY);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.BadNonce.selector, 0, 7));
        vm.prank(relayer);
        mandate.executePayment(order, v, r, s);
    }

    function test_FundWithAuthorizationGasless() public {
        // A fresh, unfunded mandate.
        address[] memory payees = new address[](1);
        payees[0] = payee1;
        vm.prank(owner);
        AgentMandate m2 = new AgentMandate(address(token), agent, TOTAL_CAP, PER_PAY_CAP, expiresAt, payees);
        assertEq(token.balanceOf(address(m2)), 0);

        // Owner signs an EIP-3009 ReceiveWithAuthorization off-chain...
        uint256 value = 60e6;
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 600;
        bytes32 nonce = keccak256("funding-1");
        bytes32 structHash = keccak256(
            abi.encode(
                token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), owner, address(m2), value, validAfter, validBefore, nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);

        // ...and a relayer submits it. The owner sends no transaction at all.
        vm.prank(relayer);
        m2.fundWithAuthorization(owner, value, validAfter, validBefore, nonce, v, r, s);
        assertEq(token.balanceOf(address(m2)), value);

        // The funded mandate is immediately usable by the agent.
        AgentMandate.PaymentOrder memory order = _order(keccak256("inv-m2"), payee1, 15e6, 0);
        bytes32 digest2 = m2.paymentOrderDigest(order);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(AGENT_KEY, digest2);
        vm.prank(relayer);
        m2.executePayment(order, v2, r2, s2);
        assertEq(token.balanceOf(payee1), 15e6);
    }

    function test_OwnerCanWithdrawUnspentAfterRevoke() public {
        vm.startPrank(owner);
        mandate.revoke();
        mandate.withdraw(100e6, owner);
        vm.stopPrank();
        assertEq(token.balanceOf(address(mandate)), 0);
        assertEq(token.balanceOf(owner), 1_000e6);
    }

    function test_OnlyOwnerCanRevoke() public {
        vm.expectRevert(AgentMandate.NotOwner.selector);
        vm.prank(agent);
        mandate.revoke();
    }
}
