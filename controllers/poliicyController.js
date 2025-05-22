const Policy = require('../models/Policy');
const axios = require('axios');
const ethers = require('ethers');
const config = require('../config/config');

const provider = new ethers.JsonRpcProvider(config.liskRpc);
const wallet = new ethers.Wallet(config.liskPrivateKey, provider);
const escrowAbi = [
  'function deposit(address token, uint256 amount, address rider) public',
  'function getBalance(address rider) public view returns (uint256)',
  'function withdraw(address token, uint256 amount, address rider) public',
];
const escrowContract = new ethers.Contract(config.escrowContractAddress, escrowAbi, wallet);
const usdcAbi = [
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) public returns (bool)',
];
const usdcContract = new ethers.Contract(config.usdcAddress, usdcAbi, wallet);

const premiums = [
  {
    id: 1,
    name: 'Basic Accident',
    amounts: { daily: 2, weekly: 50, monthly: 200, annually: 2400 },
    description: 'Essential coverage for accidents while riding',
    coverage: {
      personalAccident: true,
      medicalExpenses: true,
      thirdPartyInjury: true,
      motorcycleDamage: true,
      theftProtection: true,
    },
  },
];

async function getMpesaToken() {
  const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: `Basic ${auth}` },
  });
  return res.data.access_token;
}

exports.buyInsurance = async (req, res) => {
  const { phone, amountKes, premiumId, duration } = req.body;
  if (!phone || !amountKes || !premiumId || !duration) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const premium = premiums.find(p => p.id === premiumId);
  if (!premium || !premium.amounts[duration]) {
    return res.status(400).json({ message: 'Invalid premium or duration' });
  }

  try {
    // Get quote from Swypt
    const quoteResponse = await axios.post(
      `${config.swyptApiUrl}/swypt-quotes`,
      {
        type: 'onramp',
        amount: amountKes,
        fiatCurrency: 'KES',
        cryptoCurrency: 'USDC',
        network: 'Lisk',
      },
      { headers: { 'x-api-key': process.env.SWYPT_API_KEY, 'x-api-secret': process.env.SWYPT_API_SECRET } }
    );
    if (quoteResponse.data.statusCode !== 200) {
      throw new Error(quoteResponse.data.message);
    }

    // Initiate M-Pesa STK push
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');
    const mpesaResponse = await axios.post(
      config.mpesaApiUrl,
      {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amountKes,
        PartyA: phone,
        PartyB: process.env.MPESA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: `${config.baseUrl}mpesa-callback`,
        AccountReference: `BodaSure-${premiumId}-${duration}`,
        TransactionDesc: 'Insurance Premium',
      },
      { headers: { Authorization: `Bearer ${await getMpesaToken()}` } }
    );

    if (mpesaResponse.data.ResponseCode !== '0') {
      throw new Error('M-Pesa STK push failed');
    }

    // Initiate Swypt on-ramp
    const user = await User.findOne({ phone });
    if (!user || !user.walletAddress) {
      throw new Error('User wallet not found');
    }

    const onrampResponse = await axios.post(
      `${config.swyptApiUrl}/swypt-onramp`,
      {
        partyA: phone,
        amount: amountKes,
        side: 'onramp',
        userAddress: user.walletAddress,
        tokenAddress: config.usdcAddress,
      },
      { headers: { 'x-api-key': process.env.SWYPT_API_KEY, 'x-api-secret': process.env.SWYPT_API_SECRET } }
    );

    if (onrampResponse.data.status !== 'success') {
      throw new Error(onrampResponse.data.message);
    }

    const orderID = onrampResponse.data.data.orderID;

    // Deposit USDC to HimaEscrow
    const amountUsdc = ethers.parseUnits(quoteResponse.data.data.outputAmount, 6); // USDC: 6 decimals
    const signer = new ethers.Wallet(user.privateKey, provider);
    const approveTx = await usdcContract.connect(signer).approve(config.escrowContractAddress, amountUsdc);
    await approveTx.wait();
    const depositTx = await escrowContract.connect(signer).deposit(config.usdcAddress, amountUsdc, user.walletAddress);
    const receipt = await depositTx.wait();

    // Save policy
    const policy = new Policy({
      phone,
      premiumId,
      premiumName: premium.name,
      amountKes,
      amountUsdc: quoteResponse.data.data.outputAmount,
      duration,
      coverage: premium.coverage,
      orderID,
      transactionHash: receipt.transactionHash,
      status: 'Active',
    });
    await policy.save();

    const explorerLink = `https://sepolia-explorer.lisk.com/tx/${receipt.transactionHash}`;

    res.json({
      message: 'Insurance purchased successfully',
      orderID,
      transaction: { txHash: receipt.transactionHash, explorerLink },
    });
  } catch (error) {
    await axios.post(
      `${config.swyptApiUrl}/user-onramp-ticket`,
      {
        phone,
        amount: amountKes,
        description: `Failed insurance purchase for premium ${premiumId} (${duration})`,
        side: 'on-ramp',
        userAddress: user?.walletAddress || '',
        symbol: 'USDC',
        tokenAddress: config.usdcAddress,
        chain: 'Lisk',
      },
      { headers: { 'x-api-key': process.env.SWYPT_API_KEY, 'x-api-secret': process.env.SWYPT_API_SECRET } }
    );
    console.error('Error in buyInsurance:', error);
    res.status(500).json({ message: 'Failed to purchase insurance', error: error.message });
  }
};

exports.getPolicies = async (req, res) => {
  try {
    const policies = await Policy.find({ phone: req.user.phone });
    res.json({ policies });
  } catch (error) {
    console.error('Error in getPolicies:', error);
    res.status(500).json({ message: 'Failed to fetch policies', error: error.message });
  }
};

exports.mpesaCallback = async (req, res) => {
  const { Body } = req.body;
  const { ResultCode, CheckoutRequestID } = Body.stkCallback || {};
  console.log(`M-Pesa Callback: ${CheckoutRequestID}, Result: ${ResultCode}`);
  res.json({ ResultCode: 0, ResultDesc: 'Callback received' });
};

exports.claimPolicy = async (req, res) => {
  const { policyId } = req.body;
  if (!policyId) return res.status(400).json({ message: 'Policy ID is required' });

  try {
    const policy = await Policy.findById(policyId);
    if (!policy || policy.phone !== req.user.phone || policy.status !== 'Active') {
      return res.status(400).json({ message: 'Invalid or inactive policy' });
    }

    const user = await User.findOne({ phone: req.user.phone });
    if (!user || !user.walletAddress) {
      return res.status(400).json({ message: 'User wallet not found' });
    }

    // Withdraw USDC from HimaEscrow
    const amountUsdc = ethers.parseUnits(policy.amountUsdc || '0', 6);
    const signer = new ethers.Wallet(user.privateKey, provider);
    const withdrawTx = await escrowContract.connect(signer).withdraw(config.usdcAddress, amountUsdc, user.walletAddress);
    const receipt = await withdrawTx.wait();

    // Initiate Swypt off-ramp
    const quoteResponse = await axios.post(
      `${config.swyptApiUrl}/swypt-quotes`,
      {
        type: 'offramp',
        amount: policy.amountUsdc,
        fiatCurrency: 'KES',
        cryptoCurrency: 'USDC',
        network: 'Lisk',
        category: 'B2C',
      },
      { headers: { 'x-api-key': process.env.SWYPT_API_KEY, 'x-api-secret': process.env.SWYPT_API_SECRET } }
    );
    if (quoteResponse.data.statusCode !== 200) {
      throw new Error(quoteResponse.data.message);
    }

    const offrampResponse = await axios.post(
      `${config.swyptApiUrl}/swypt-order-offramp`,
      {
        chain: 'Lisk',
        hash: receipt.transactionHash,
        partyB: user.phone,
        tokenAddress: config.usdcAddress,
      },
      { headers: { 'x-api-key': process.env.SWYPT_API_KEY, 'x-api-secret': process.env.SWYPT_API_SECRET } }
    );

    if (offrampResponse.data.status !== 'success') {
      throw new Error(offrampResponse.data.message);
    }

    policy.status = 'Claimed';
    await policy.save();

    const explorerLink = `https://sepolia-explorer.lisk.com/tx/${receipt.transactionHash}`;

    res.json({
      message: 'Claim processed successfully',
      transaction: { txHash: receipt.transactionHash, explorerLink },
      orderID: offrampResponse.data.data.orderID,
    });
  } catch (error) {
    await axios.post(
      `${config.swyptApiUrl}/create-offramp-ticket`,
      {
        phone: req.user.phone,
        amount: policy?.amountUsdc || '0',
        description: `Failed claim for policy ${policyId}`,
        side: 'off-ramp',
        userAddress: user?.walletAddress || '',
        symbol: 'USDC',
        tokenAddress: config.usdcAddress,
        chain: 'Lisk',
      },
      { headers: { 'x-api-key': process.env.SWYPT_API_KEY, 'x-api-secret': process.env.SWYPT_API_SECRET } }
    );
    console.error('Error in claimPolicy:', error);
    res.status(500).json({ message: 'Failed to process claim', error: error.message });
  }
};