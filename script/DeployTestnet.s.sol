// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AgentMandate} from "../src/AgentMandate.sol";

/// @notice Aevum Testnet deployment (chain 44005). NOT run during local
///         development; it needs a deployer wallet funded from the QDay
///         Discord faucet (1 tQDAY + 5 tUSD8). See README "Deploy to testnet".
///
///         Required env:
///           DEPLOYER_KEY   private key of the owner/deployer wallet
///           AGENT_ADDRESS  the agent's address (its key stays in the agent)
///           PAYEES         comma-separated allowlist addresses
///         Optional env: TOTAL_CAP (default 5e6 = 5 tUSD8, the faucet amount),
///           PER_PAYMENT_CAP (default 2e6), EXPIRY_DAYS (default 30).
///
///         Run with legacy transactions (Aevum uses type-0 txs):
///           forge script script/DeployTestnet.s.sol --rpc-url https://rpc-test.qday.info \
///             --broadcast --legacy
contract DeployTestnet is Script {
    address internal constant TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        address agent = vm.envAddress("AGENT_ADDRESS");
        address[] memory payees = vm.envAddress("PAYEES", ",");
        uint256 totalCap = vm.envOr("TOTAL_CAP", uint256(5e6));
        uint256 perPayCap = vm.envOr("PER_PAYMENT_CAP", uint256(2e6));
        uint256 expiryDays = vm.envOr("EXPIRY_DAYS", uint256(30));

        vm.startBroadcast(deployerKey);
        AgentMandate mandate = new AgentMandate(
            TUSD8, agent, totalCap, perPayCap, uint64(block.timestamp + expiryDays * 1 days), payees
        );
        vm.stopBroadcast();

        console2.log("AgentMandate deployed on Aevum Testnet:", address(mandate));
        console2.log("Explorer:", "https://explorer-test.qday.info");
        console2.log("Next: fund it (approve + fund, or the gasless fundWithAuthorization flow),");
        console2.log("then record this address and the deploy tx hash in the README table.");
    }
}
