const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Africastalking = require('africastalking');
const ethers = require('ethers');
const crypto = require('crypto');
const config = require('../config/config');

const africastalking = Africastalking({
  username: config.africastalkingUsername,
  apiKey: config.africastalkingApiKey,
});

const provider = new ethers.JsonRpcProvider(config.liskRpc);
const liskWallet = new ethers.Wallet(config.liskPrivateKey, provider);

exports.requestOtp = async (req, res) => {
  const { phone } = req.body;
  let formattedPhone = phone;

  if (!phone.match(/^(\+254|254|0|07)\d{9}$/)) {
    return res.status(400).json({ message: 'Invalid phone number format' });
  }

  if (phone.startsWith('7') && phone.length === 9) {
    formattedPhone = '254' + phone;
  } else if (phone.startsWith('07') && phone.length === 10) {
    formattedPhone = '254' + phone.slice(1);
  } else if (phone.startsWith('+254') && phone.length === 13) {
    formattedPhone = phone.slice(1);
  } else if (phone.startsWith('254') && phone.length === 12) {
    formattedPhone = phone;
  } else {
    return res.status(400).json({ message: 'Phone number must be in +254, 254, 07, or 7 format followed by 9 digits' });
  }

  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = await bcrypt.hash(otp, 10);
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

    console.log('Request OTP:', { formattedPhone, otp, expires: otpExpires });

    let user = await User.findOne({ phone: formattedPhone });
    if (!user) {
      user = new User({ phone: formattedPhone, otpHash, otpExpires });
    } else {
      user.otpHash = otpHash;
      user.otpExpires = otpExpires;
    }

    await user.save();
    console.log('User Saved:', { phone: user.phone, otpExpires });

    const smsResponse = await africastalking.SMS.send({
      to: [`+${formattedPhone}`],
      message: `Your BodaSure OTP is ${otp}. Valid until ${otpExpires.toLocaleString('en-US', { timeZone: 'Africa/Nairobi' })}.`,
      from: config.africastalkingSenderId,
    });
    console.log('SMS Response:', smsResponse);

    res.json({ message: 'OTP sent successfully' });
  } catch (error) {
    console.error('Error in requestOtp:', error);
    res.status(500).json({ message: 'Failed to send OTP', error: error.message });
  }
};

exports.verifyOtp = async (req, res) => {
  const { phone, otp } = req.body;
  let formattedPhone = phone;

  if (!phone.match(/^(\+254|254|0|07)\d{9}$/)) {
    return res.status(400).json({ message: 'Invalid phone number format' });
  }

  if (phone.startsWith('7') && phone.length === 9) {
    formattedPhone = '254' + phone;
  } else if (phone.startsWith('07') && phone.length === 10) {
    formattedPhone = '254' + phone.slice(1);
  } else if (phone.startsWith('+254') && phone.length === 13) {
    formattedPhone = phone.slice(1);
  } else if (phone.startsWith('254') && phone.length === 12) {
    formattedPhone = phone;
  } else {
    return res.status(400).json({ message: 'Phone number must be in +254, 254, 07, or 7 format followed by 9 digits' });
  }

  try {
    const user = await User.findOne({ phone: formattedPhone });
    console.log('Verify OTP:', { formattedPhone, userFound: !!user });

    if (!user) {
      return res.status(400).json({ message: 'User not found' });
    }

    if (user.otpExpires < new Date()) {
      console.log('OTP Expired:', { expires: user.otpExpires, now: new Date() });
      return res.status(400).json({ message: 'OTP has expired' });
    }

    const isValid = await bcrypt.compare(otp, user.otpHash);
    console.log('OTP Validation:', { otp, isValid });

    if (!isValid) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    const token = jwt.sign({ phone: formattedPhone }, config.jwtSecret, { expiresIn: '1d' });
    user.otpHash = null;
    user.otpExpires = null;
    await user.save();
    console.log('User Updated:', { phone: user.phone });

    res.json({ token, phone: formattedPhone, message: 'OTP verified successfully' });
  } catch (error) {
    console.error('Error in verifyOtp:', error);
    res.status(500).json({ message: 'Failed to verify OTP', error: error.message });
  }
};

exports.registerComplete = async (req, res) => {
  const { phone, motorcycle } = req.body;
  console.log('registerComplete called:', { phone, motorcycle, timestamp: new Date().toISOString() });
  try {
    // Normalize phone number
    let formattedPhone = phone;
    if (!phone.match(/^(\+254|254|0|07)\d{9}$/)) {
      console.log('Invalid phone number format:', { phone });
      return res.status(400).json({ message: 'Invalid phone number format' });
    }
    if (phone.startsWith('7') && phone.length === 9) {
      formattedPhone = '254' + phone;
    } else if (phone.startsWith('07') && phone.length === 10) {
      formattedPhone = '254' + phone.slice(1);
    } else if (phone.startsWith('+254') && phone.length === 13) {
      formattedPhone = phone.slice(1);
    } else if (phone.startsWith('254') && phone.length === 12) {
      formattedPhone = phone;
    } else {
      console.log('Phone number must be in +254, 254, 07, or 7 format:', { phone });
      return res.status(400).json({ message: 'Phone number must be in +254, 254, 07, or 7 format followed by 9 digits' });
    }

    // Check if phone number is already registered
    console.log('Checking for existing registration...');
    const existingUser = await User.findOne({ phone: formattedPhone });
    if (existingUser && existingUser.walletAddress) {
      console.log('Phone number already registered:', { phone: formattedPhone, walletAddress: existingUser.walletAddress });
      return res.status(400).json({ message: 'Phone number is already registered' });
    }
    if (!existingUser) {
      console.log('User not found for registration:', { phone: formattedPhone });
      return res.status(400).json({ message: 'User not found. Please request and verify OTP first' });
    }

    // Validate motorcycle object
    console.log('Validating motorcycle data...');
    if (!motorcycle || typeof motorcycle !== 'object') {
      console.log('Invalid motorcycle data:', { motorcycle });
      return res.status(400).json({ message: 'Motorcycle data must be an object' });
    }
    const { type, licensePlate, model, year, engineCapacity } = motorcycle;
    if (!type || !licensePlate || !model || !year || !engineCapacity) {
      console.log('Missing motorcycle fields:', { type, licensePlate, model, year, engineCapacity });
      return res.status(400).json({ message: 'Motorcycle must include type, licensePlate, model, year, and engineCapacity' });
    }
    if (typeof year !== 'number' || year < 1900 || year > new Date().getFullYear() + 1) {
      console.log('Invalid year:', { year });
      return res.status(400).json({ message: 'Invalid year' });
    }
    if (typeof engineCapacity !== 'number' || engineCapacity <= 0) {
      console.log('Invalid engineCapacity:', { engineCapacity });
      return res.status(400).json({ message: 'Invalid engine capacity' });
    }

    console.log('Creating new wallet...');
    const userWallet = ethers.Wallet.createRandom();

    console.log('Updating user data...');
    existingUser.motorcycle = { type, licensePlate, model, year, engineCapacity };
    existingUser.walletAddress = userWallet.address;
    // Validate encryption key
    console.log('Validating encryption key...');
    if (!config.encryptionKey) {
      throw new Error('Encryption key is missing in configuration');
    }
    if (!/^[0-9a-fA-F]{64}$/.test(config.encryptionKey)) {
      throw new Error('Encryption key must be a 64-character hexadecimal string');
    }
    const encryptionKey = Buffer.from(config.encryptionKey, 'hex');
    if (encryptionKey.length !== 32) {
      throw new Error('Encryption key must decode to 32 bytes');
    }
    // Encrypt private key with AES-256-CBC
    console.log('Encrypting private key...');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey, iv);
    existingUser.privateKey = cipher.update(userWallet.privateKey, 'utf8', 'hex') + cipher.final('hex');
    existingUser.privateKeyIV = iv.toString('hex');

    console.log('Saving user to database...');
    await existingUser.save();

    // Log wallet addresses
    console.log('New Wallet Created:', {
      address: userWallet.address,
      liskWallet: liskWallet.address,
      message: 'Preparing to send 0 CELO from lisk wallet to new wallet',
    });

    // Check lisk wallet balance for gas fees
    console.log('Checking lisk wallet balance...');
    const balance = await provider.getBalance(liskWallet.address);
    const amount = ethers.parseUnits('0', 18); // 0 CELO
    const gasLimit = ethers.toBigInt(21000); // Standard gas limit for simple transfer

    // Get gas pricing
    console.log('Fetching gas pricing...');
    let maxFeePerGas, maxPriorityFeePerGas;
    try {
      const feeData = await provider.getFeeData();
      maxFeePerGas = feeData.maxFeePerGas || ethers.parseUnits('5', 'gwei');
      maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits('1', 'gwei');
    } catch (error) {
      console.warn('Failed to fetch fee data, using fallback gas prices:', error.message);
      maxFeePerGas = ethers.parseUnits('5', 'gwei');
      maxPriorityFeePerGas = ethers.parseUnits('1', 'gwei');
    }

    // Estimate gas cost
    const gasEstimate = gasLimit * maxFeePerGas;
    console.log('Gas estimate:', {
      gasLimit: gasLimit.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
      gasEstimate: ethers.formatUnits(gasEstimate, 18),
      balance: ethers.formatUnits(balance, 18),
    });

    if (balance < gasEstimate) {
      console.log('Insufficient balance in lisk wallet:', {
        available: ethers.formatUnits(balance, 18),
        required: ethers.formatUnits(gasEstimate, 18),
      });
      return res.status(400).json({
        message: `Insufficient CELO in lisk wallet for gas fees. Available: ${ethers.formatUnits(balance, 18)} CELO, Required: ${ethers.formatUnits(gasEstimate, 18)} CELO`,
        walletAddress: liskWallet.address,
        fundingInstructions: 'Send Celo Alfajores testnet CELO to this address via a faucet like https://faucet.celo.org/alfajores',
      });
    }

    // Prepare transaction from lisk wallet to new wallet
    console.log('Preparing transaction...', {
      from: liskWallet.address,
      to: userWallet.address,
      value: amount.toString(),
    });
    const tx = {
      to: userWallet.address,
      value: amount,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };

    // Send transaction
    console.log('Sending transaction...');
    const sendTx = await liskWallet.sendTransaction(tx);
    console.log('Transaction sent:', { txHash: sendTx.hash });

    // Wait for transaction with timeout
    console.log('Waiting for transaction confirmation...');
    let receipt;
    try {
      receipt = await sendTx.wait(1, 60000); // Wait for 1 confirmation, 60s timeout
      console.log('Transaction receipt:', {
        transactionHash: receipt.transactionHash,
        status: receipt.status,
        blockNumber: receipt.blockNumber,
      });
    } catch (error) {
      console.error('Error waiting for transaction:', error);
      throw new Error(`Failed to confirm transaction ${sendTx.hash}: ${error.message}`);
    }

    if (receipt.status === 0) {
      console.log('Transaction reverted:', { txHash: receipt.transactionHash });
      throw new Error('Transaction reverted');
    }

    // Fallback to sendTx.hash if receipt.transactionHash is undefined
    const txHash = receipt.transactionHash || sendTx.hash;
    const explorerLink = `https://alfajores-blockscout.celo-testnet.org/tx/${txHash}`;

    console.log('Wallet Registered:', {
      newWallet: userWallet.address,
      phone: formattedPhone,
      txHash,
      from: liskWallet.address,
      explorerLink,
    });

    res.json({
      message: 'Registration complete with wallet address registered',
      wallet: {
        address: userWallet.address,
        mnemonic: userWallet.mnemonic.phrase,
      },
      transaction: {
        txHash,
        explorerLink,
      },
      liskInstructions: {
        network: 'Celo Alfajores Testnet',
        rpcUrl: config.liskRpc,
        chainId: 44787,
        blockExplorer: 'https://alfajores-blockscout.celo-testnet.org',
        steps: [
          `Add Celo Alfajores to MetaMask: Network Name: Celo Alfajores, RPC URL: ${config.liskRpc}, Chain ID: 44787, Currency: CELO`,
          'Fund wallet with testnet CELO via Celo Alfajores faucet: https://faucet.celo.org/alfajores',
          `View your transaction at: ${explorerLink}`,
        ],
      },
    });
  } catch (error) {
    console.error('Error in registerComplete:', error);
    if (error.code === 11000) {
      console.log('Duplicate phone number detected:', { phone });
      return res.status(400).json({ message: 'Phone number is already registered' });
    }
    if (error.code === 'CALL_EXCEPTION' && error.receipt) {
      res.status(500).json({
        message: 'Transaction failed',
        error: `Transaction reverted: ${error.reason || 'Unknown reason'}`,
        transactionHash: error.receipt.transactionHash,
        explorerLink: `https://alfajores-blockscout.celo-testnet.org/tx/${error.receipt.transactionHash}`,
      });
    } else {
      res.status(500).json({ message: 'Registration failed', error: error.message });
    }
  }
};

exports.getUser = async (req, res) => {
  try {
    if (!req.user || !req.user.phone) {
      console.log('Authentication failed: req.user or req.user.phone is undefined');
      return res.status(401).json({ message: 'Authentication failed: User not identified' });
    }

    console.log('Fetching user data for:', req.user.phone);
    const user = await User.findOne({ phone: req.user.phone });
    
    if (!user) {
      console.log('User not found:', req.user.phone);
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({
      phone: user.phone,
      walletAddress: user.walletAddress || null,
      motorcycle: user.motorcycle || null,
    });
  } catch (error) {
    console.error('Error in getUser:', error);
    res.status(500).json({ message: 'Failed to fetch user data', error: error.message });
  }
};