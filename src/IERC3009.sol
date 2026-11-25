// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal EIP-3009 surface implemented by tUSD8 on Aevum Testnet.
/// @dev `receiveWithAuthorization` may only be called by the payee itself, which
///      is what lets a contract pull a signed authorization into itself.
interface IERC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @notice The slice of ERC-20 this project uses.
interface IERC20Mini {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}
