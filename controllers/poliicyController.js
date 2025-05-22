const Policy = require('../models/Policy');
const Premium = require('../models/Premium');
const User = require('../models/User');
const axios = require('axios');
const ethers = require('ethers');
const crypto = require('crypto');
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

async function getMpesaToken() {
  const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: `Basic ${auth}` },
  });
  return res.data.access_token;
}

exports.buyInsurance = async (req, res) => {
  const { phone, amountKes, premiumId, duration } = req.body;
  console.log('buyInsurance called:', { phone, amountKes, premiumId, duration });
  if (!phone || !amountKes || !premiumId || !duration) {
    console.log('Missing required fields:', { phone, amountKes, premiumId, duration });
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const validDurations = ['daily', 'weekly', 'monthly', 'annually'];
  if (!validDurations.includes(duration)) {
    console.log('Invalid duration:', { duration });
    return res.status(400).json({ message: 'Invalid duration' });
  }

  let user = null;
  try {
    console.log('Fetching premium...');
    const premium = await Premium.findOne({ id: premiumId });
    if (!premium) {
      console.log('Premium not found:', { premiumId });
      return res.status(400).json({ message: 'Invalid premium' });
    }

    console.log('Fetching user...');
    user = await User.findOne({ phone });
    if (!user || !user.walletAddress) {
      console.log('User wallet not found:', { phone });
      return res.status(400).json({ message: 'User wallet not found. Please complete registration.' });
    }

    console.log('Fetching Swypt quote...');
    const quoteResponse = await axios.post(
      `${config.swyptApiUrl}/swypt-quotes`,
      {
        type: 'onramp',
        amount: amountKes,
        fiatCurrency: 'KES',
        cryptoCurrency: 'USDC',
        network: 'Base',
      },
      { headers: { 'x-api-key': process.env.SWYPT_API_KEY, 'x-api-secret': process.env.SWYPT_API_SECRET } }
    );
    if (quoteResponse.data.statusCode !== 200) {
      console.log('Swypt quote failed:', quoteResponse.data.message);
      throw new Error(quoteResponse.data.message);
    }

    console.log('Initiating M-Pesa STK push...');
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
      console.log('M-Pesa STK push failed:', mpesaResponse.data);
      throw new Error('M-Pesa STK push failed');
    }

    console.log('Initiating Swypt on-ramp...');
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
      console.log('Swypt on-ramp failed:', onrampResponse.data.message);
      throw new Error(onrampResponse.data.message);
    }

    const orderID = onrampResponse.data.data.orderID;

    console.log('Depositing USDC to escrow...');
    const amountUsdc = ethers.parseUnits(quoteResponse.data.data.outputAmount, 6);
    const encryptionKey = Buffer.from(config.encryptionKey, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', encryptionKey, Buffer.from(user.privateKeyIV, 'hex'));
    let decryptedPrivateKey = decipher.update(user.privateKey, 'hex', 'utf8') + decipher.final('utf8');
    const signer = new ethers.Wallet(decryptedPrivateKey, provider);
    const approveTx = await usdcContract.connect(signer).approve(config.escrowContractAddress, amountUsdc);
    await approveTx.wait();
    const depositTx = await escrowContract.connect(signer).deposit(config.usdcAddress, amountUsdc, user.walletAddress);
    const receipt = await depositTx.wait();

    console.log('Saving policy...');
    const policy = new Policy({
      phone,
      premiumId,
      premiumName: premium.name,
      amountKes,
      amountUsdc: quoteResponse.data.data.outputAmount,
      duration,
      coverage: premium.coverages.reduce((acc, cov) => ({ ...acc, [cov.id]: cov.included }), {}),
      orderID,
      transactionHash: receipt.transactionHash,
      status: 'Active',
    });
    await policy.save();

    const explorerLink = `https://sepolia.basescan.org/tx/${receipt.transactionHash}`;

    console.log('Insurance purchased:', { orderID, txHash: receipt.transactionHash, explorerLink });

    res.json({
      message: 'Insurance purchased successfully',
      orderID,
      transaction: { txHash: receipt.transactionHash, explorerLink },
    });
  } catch (error) {
    console.error('Error in buyInsurance:', error.message, error.response?.data || {});
    if (user && user.walletAddress) {
      try {
        await axios.post(
          `${config.swyptApiUrl}/user-onramp-ticket`,
          {
            phone,
            amount: amountKes,
            description: `Failed insurance purchase for premium ${premiumId} (${duration})`,
            side: 'on-ramp',
            userAddress: user.walletAddress,
            symbol: 'USDC',
            tokenAddress: config.usdcAddress,
            chain: 'Base',
          },
          { headers: { 'x-api-key': process.env.SWYPT_API_KEY, 'x-api-secret': process.env.SWYPT_API_SECRET } }
        );
      } catch (ticketError) {
        console.error('Failed to create Swypt ticket:', ticketError.message, ticketError.response?.data || {});
      }
    } else {
      console.log('Skipping ticket creation: No user wallet address available');
    }
    res.status(500).json({ message: 'Failed to purchase insurance', error: error.message });
  }
};

exports.getPremiums = async (req, res) => {
  try {
    console.log('Fetching all premiums');
    const premiums = await Premium.find({});
    res.json({ premiums });
  } catch (error) {
    console.error('Error in getPremiums:', error);
    res.status(500).json({ message: 'Failed to fetch premiums', error: error.message });
  }
};

exports.test = async (req, res) => {
  res.json({
    message: 'Test endpoint',
    data: {
      phone: req.user.phone,
      walletAddress: req.user.walletAddress,
    },
  })
}

exports.getPolicies = async (req, res) => {
  try {
    console.log('Fetching policies for:', req.user.phone);
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
  console.log('claimPolicy called:', { policyId });
  if (!policyId) {
    console.log('Missing policyId');
    return res.status(400).json({ message: 'Policy ID is required' });
  }

  try {
    console.log('Fetching policy...');
    const policy = await Policy.findById(policyId);
    if (!policy || policy.phone !== req.user.phone || policy.status !== 'Active') {
      console.log('Invalid policy:', { policyId, phone: req.user.phone, status: policy?.status });
      return res.status(400).json({ message: 'Invalid or inactive policy' });
    }

    console.log('Fetching user...');
    const user = await User.findOne({ phone: req.user.phone });
    if (!user || !user.walletAddress) {
      console.log('User wallet not found:', { phone: req.user.phone });
      return res.status(400).json({ message: 'User wallet not found' });
    }

    console.log('Withdrawing USDC from escrow...');
    const amountUsdc = ethers.parseUnits(policy.amountUsdc || '0', 6);
    const encryptionKey = Buffer.from(config.encryptionKey, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', encryptionKey, Buffer.from(user.privateKeyIV, 'hex'));
    let decryptedPrivateKey = decipher.update(user.privateKey, 'hex', 'utf8') + decipher.final('utf8');
    const signer = new ethers.Wallet(decryptedPrivateKey, provider);
    const withdrawTx = await escrowContract.connect(signer).withdraw(config.usdcAddress, amountUsdc, user.walletAddress);
    const receipt = await depositTx.wait();

    console.log('Fetching Swypt off-ramp quote...');
    const quoteResponse = await axios.post(
      `${config.swyptApiUrl}/swypt-quotes`,
      {
        type: 'offramp',
        amount: policy.amountUsdc,
        fiatCurrency: 'KES',
        cryptoCurrency: 'USDC',
        network: 'Base',
        category: 'B2C',
      },
      { headers: { 'x-api-key': process.env.SWYPT_API_KEY, 'x-api-secret': process.env.SWYPT_API_SECRET } }
    );
    if (quoteResponse.data.statusCode !== 200) {
      console.log('Swypt off-ramp quote failed:', quoteResponse.data.message);
      throw new Error(quoteResponse.data.message);
    }

    console.log('Initiating Swypt off-ramp...');
    const offrampResponse = await axios.post(
      `${config.swyptApiUrl}/swypt-order-offramp`,
      {
        chain: 'Base',
        hash: receipt.transactionHash,
        partyB: user.phone,
        tokenAddress: config.usdcAddress,
      },
      { headers: { 'x-api-key': process.env.SWYPT_API_KEY, 'x-api-secret': process.env.SWYPT_API_SECRET } }
    );

    if (offrampResponse.data.status !== 'success') {
      console.log('Swypt off-ramp failed:', offrampResponse.data.message);
      throw new Error(offrampResponse.data.message);
    }

    console.log('Updating policy status...');
    policy.status = 'Claimed';
    await policy.save();

    const explorerLink = `https://sepolia.basescan.org/tx/${receipt.transactionHash}`;

    console.log('Claim processed:', { txHash: receipt.transactionHash, orderID: offrampResponse.data.data.orderID });

    res.json({
      message: 'Claim processed successfully',
      transaction: { txHash: receipt.transactionHash, explorerLink },
      orderID: offrampResponse.data.data.orderID,
    });
  } catch (error) {
    console.error('Error in claimPolicy:', error);
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
        chain: 'Base',
      },
      { headers: { 'x-api-key': process.env.SWYPT_API_KEY, 'x-api-secret': process.env.SWYPT_API_SECRET } }
    );
    res.status(500).json({ message: 'Failed to process claim', error: error.message });
  }
};