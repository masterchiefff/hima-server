// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract HimaEscrow {
    mapping(address => mapping(address => uint256)) public balances; 
    address public owner;
    mapping(address => bool) public supportedTokens;

    constructor(address _usdc) {
        owner = msg.sender;
        supportedTokens[_usdc] = true;
        // supportedTokens[_cusd] = true;
        // supportedTokens[_usdt] = true;
    }

    function deposit(address token, uint256 amount, address rider) external {
        require(msg.sender == owner, "Only owner can deposit");
        require(supportedTokens[token], "Token not supported");
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "Transfer failed");
        balances[rider][token] += amount;
    }

    function getBalance(address rider, address token) external view returns (uint256) {
        require(supportedTokens[token], "Token not supported");
        return balances[rider][token];
    }

    function withdraw(address token, uint256 amount, address rider) external {
        require(msg.sender == owner, "Only owner can withdraw");
        require(supportedTokens[token], "Token not supported");
        require(balances[rider][token] >= amount, "Insufficient balance");
        balances[rider][token] -= amount;
        require(IERC20(token).transfer(rider, amount), "Withdrawal failed");
    }
}