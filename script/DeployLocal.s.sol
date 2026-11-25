// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AgentMandate} from "../src/AgentMandate.sol";
import {MockUSD8} from "../src/MockUSD8.sol";

/// @notice Local demo deployment against anvil started with:
///         anvil --hardfork shanghai --chain-id 44005
///         Uses anvil's well-known dev keys. LOCAL ONLY, never use on testnet.
contract DeployLocal is Script {
    // anvil account #0 (owner) and #1 (agent): public dev keys, local use only.
    uint256 internal constant OWNER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address internal constant AGENT = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address internal constant PAYEE1 = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;
    address internal constant PAYEE2 = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65;

    function run() external {
        address owner = vm.addr(OWNER_KEY);
        vm.startBroadcast(OWNER_KEY);

        MockUSD8 token = new MockUSD8();
        token.mint(owner, 1_000e6);

        address[] memory payees = new address[](2);
        payees[0] = PAYEE1;
        payees[1] = PAYEE2;

        AgentMandate mandate = new AgentMandate(
            address(token), AGENT, 100e6, 40e6, uint64(block.timestamp + 7 days), payees
        );
        token.approve(address(mandate), 100e6);
        mandate.fund(100e6);

        vm.stopBroadcast();

        console2.log("MockUSD8 (local only):", address(token));
        console2.log("AgentMandate:        ", address(mandate));
        console2.log("Owner:               ", owner);
        console2.log("Agent:               ", AGENT);
    }
}
