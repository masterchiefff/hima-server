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

  if (!formattedPhone || !amountKes || !premiumId || !duration) {
    console.log('Missing required fields:', { formattedPhone, amountKes, premiumId, duration });
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
    const premium = await Premium.findOne({ id: premiumId }); // Assumes Premium model has 'id' as String
    if (!premium) {
      console.log('Premium not found:', { premiumId });
      return res.status(400).json({ message: 'Invalid premium' });
    }

    console.log('Fetching user...');
    user = await User.findOne({ phone: formattedPhone });
    if (!user || !user.walletAddress) {
      console.log('User wallet not found:', { formattedPhone });
      return res.status(400).json({ message: 'User wallet not found. Please complete registration.' });
    }

    console.log('Fetching Swypt quote...');
    const quoteResponse = await axios.post(
      'https://pool.swypt.io/api/swypt-quotes',
      {
        type: 'onramp',
        amount: amountKes.toString(),
        fiatCurrency: 'KES',
        cryptoCurrency: 'cKES',
        network: 'celo',
      },
      { headers: { 'x-api-key': process.env.SWYPT_API_KEY, 'x-api-secret': process.env.SWYPT_API_SECRET } }
    );
    if (quoteResponse.data.statusCode !== 200) {
      console.log('Swypt quote failed:', quoteResponse.data.message);
      throw new Error(quoteResponse.data.message);
    }

    console.log('Initiating Swypt on-ramp...');
    const maxRetries = 3;
    let retryCount = 0;
    let onrampResponse;
    while (retryCount < maxRetries) {
      try {
        onrampResponse = await axios.post(
          'https://pool.swypt.io/api/swypt-onramp',
          {
            partyA: formattedPhone,
            amount: amountKes.toString(),
            side: 'onramp',
            userAddress: user.walletAddress,
            tokenAddress: config.usdcAddress, // Should be cKES: 0x3a0d9d7764FAE860A659eb96A500F1323b411e68
          },
          { headers: { 'x-api-key': process.env.SWYPT_API_KEY, 'x-api-secret': process.env.SWYPT_API_SECRET } }
        );

        if (onrampResponse.data.status !== 'success' || !onrampResponse.data.data?.orderID) {
          throw new Error(`Swypt on-ramp failed: ${onrampResponse.data.message || 'Invalid response format'}`);
        }
        console.log('Swypt on-ramp response:', JSON.stringify(onrampResponse.data, null, 2));
        break;
      } catch (error) {
        retryCount++;
        console.error(`Swypt on-ramp attempt ${retryCount} failed:`, error.message);
        if (retryCount === maxRetries) {
          console.error('Max retries reached for Swypt on-ramp');
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    const orderID = onrampResponse.data.data.orderID;

    // Save preliminary policy
    console.log('Saving preliminary policy...');
    const policy = new Policy({
      phone: formattedPhone,
      premiumId, // Now a String, matching "basic-accident"
      premiumName: premium.name,
      amountKes,
      amountUsdc: quoteResponse.data.data.outputAmount,
      duration,
      coverage: premium.coverages.reduce((acc, cov) => ({ ...acc, [cov.id]: cov.included }), {}),
      orderID,
      status: 'Pending', // Now valid in the enum
      mpesaStatus: 'Pending',
    });
    await policy.save();

    // Return early to inform user of STK push
    res.status(202).json({
      message: 'STK Push initiated. Please complete the M-Pesa payment to proceed.',
      orderID,
    });

    // Continue processing asynchronously
    setImmediate(async () => {
      try {
        // Check on-ramp status
        console.log('Checking on-ramp status...');
        let statusResponse;
        let attempts = 0;
        const maxStatusAttempts = config.statusCheckMaxAttempts || 12; // 60 seconds
        const statusCheckInterval = config.statusCheckInterval || 5000;
        while (attempts < maxStatusAttempts) {
          statusResponse = await axios.get(
            `https://pool.swypt.io/api/order-onramp-status/${orderID}`,
            { headers: { 'x-api-key': process.env.SWYPT_API_KEY, 'x-api-secret': process.env.SWYPT_API_SECRET } }
          );
          if (statusResponse.data.status === 'success' && statusResponse.data.data.status === 'SUCCESS') {
            console.log('STK push successful:', JSON.stringify(statusResponse.data, null, 2));
            break;
          } else if (statusResponse.data.status === 'success' && statusResponse.data.data.status === 'FAILED') {
            console.log('STK push failed:', statusResponse.data.data.message);
            throw new Error(`STK push failed: ${statusResponse.data.data.message}`);
          }
          console.log(`Attempt ${attempts + 1}: STK push status ${statusResponse.data.data?.status || 'unknown'}`);
          await new Promise(resolve => setTimeout(resolve, statusCheckInterval));
          attempts++;
        }
        if (!statusResponse || statusResponse.data.data.status !== 'SUCCESS') {
          throw new Error('STK push not confirmed within timeout');
        }

        // Process crypto deposit
        console.log('Processing crypto deposit...');
        const depositResponse = await axios.post(
          'https://pool.swypt.io/api/swypt-deposit',
          {
            chain: 'celo',
            address: user.walletAddress,
            orderID,
            project: 'onramp',
          },
          { headers: { 'x-api-key': process.env.SWYPT_API_KEY, 'x-api-secret': process.env.SWYPT_API_SECRET } }
        );
        if (depositResponse.data.status !== 200) {
          console.log('Swypt deposit failed:', depositResponse.data.message);
          throw new Error(`Swypt deposit failed: ${depositResponse.data.message}`);
        }
        console.log('Crypto deposit successful:', depositResponse.data.hash);

        // Verify cKES balance
        console.log('Verifying cKES balance after deposit...');
        const amountUsdc = ethers.parseUnits(quoteResponse.data.data.outputAmount, 18); // cKES has 18 decimals
        let usdcBalance = await usdcContract.balanceOf(user.walletAddress);
        attempts = 0;
        const maxBalanceAttempts = config.balanceCheckMaxAttempts || 20;
        const balanceCheckInterval = config.balanceCheckInterval || 5000;
        while (usdcBalance < amountUsdc && attempts < maxBalanceAttempts) {
          console.log(`Attempt ${attempts + 1}: cKES balance ${ethers.formatUnits(usdcBalance, 18)} < ${ethers.formatUnits(amountUsdc, 18)}`);
          await new Promise(resolve => setTimeout(resolve, balanceCheckInterval));
          usdcBalance = await usdcContract.balanceOf(user.walletAddress);
          attempts++;
        }
        if (usdcBalance < amountUsdc) {
          console.log('Swypt deposit failed to credit sufficient cKES:', {
            expected: ethers.formatUnits(amountUsdc, 18),
            actual: ethers.formatUnits(usdcBalance, 18),
          });
          throw new Error('Swypt deposit failed to credit sufficient cKES');
        }
        console.log('cKES balance verified:', ethers.formatUnits(usdcBalance, 18), 'cKES');

        // Deposit to escrow
        console.log('Depositing cKES to escrow...');
        const encryptionKey = Buffer.from(config.encryptionKey, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', encryptionKey, Buffer.from(user.privateKeyIV, 'hex'));
        let decryptedPrivateKey = decipher.update(user.privateKey, 'hex', 'utf8') + decipher.final('utf8');
        const signer = new ethers.Wallet(decryptedPrivateKey, provider);

        console.log('Signer address:', signer.address);
        const celoBalance = await provider.getBalance(signer.address);
        console.log('Signer CELO balance:', ethers.formatEther(celoBalance), 'CELO');
        if (celoBalance === 0n) {
          throw new Error('Signer wallet has 0 CELO. Please fund the wallet with CELO for gas fees.');
        }

        console.log('Approving cKES for escrow...');
        const approveTx = await usdcContract.connect(signer).approve(config.escrowContractAddress, amountUsdc, { gasLimit: 100000 });
        console.log('Approve transaction hash:', approveTx.hash);
        await approveTx.wait();

        console.log('Depositing cKES to escrow contract...');
        const depositTx = await escrowContract.connect(signer).deposit(config.usdcAddress, amountUsdc, user.walletAddress, { gasLimit: 200000 });
        console.log('Deposit transaction hash:', depositTx.hash);
        const receipt = await depositTx.wait();

        console.log('Updating policy to active...');
        await Policy.updateOne(
          { orderID },
          {
            transactionHash: receipt.transactionHash,
            status: 'Active',
            mpesaStatus: 'Success',
            mpesaResultDesc: statusResponse.data.data.details.resultDescription,
          }
        );

        const explorerLink = `https://alfajores-blockscout.celo-testnet.org/tx/${receipt.transactionHash}`;
        console.log('Insurance purchased:', { orderID, txHash: receipt.transactionHash, explorerLink });

        // Optionally notify user
        // await notifyUser(user, { message: 'Insurance purchase completed', orderID, txHash: receipt.transactionHash });
      } catch (error) {
        console.error('Async error in buyInsurance:', {
          message: error.message,
          code: error.code,
          transaction: error.transaction,
          receipt: error.receipt,
          reason: error.reason,
        });
        await Policy.updateOne({ orderID }, { status: 'Failed', mpesaResultDesc: error.message });
        try {
          await axios.post(
            'https://pool.swypt.io/api/user-onramp-ticket',
            {
              phone: formattedPhone,
              amount: amountKes.toString(),
              description: `Failed insurance purchase for premium ${premiumId} (${duration}): ${error.message}`,
              side: 'on-ramp',
              userAddress: user.walletAddress,
              symbol: 'cKES',
              tokenAddress: config.usdcAddress,
              chain: 'celo',
            },
            { headers: { 'x-api-key': process.env.SWYPT_API_KEY, 'x-api-secret': process.env.SWYPT_API_SECRET } }
          );
        } catch (ticketError) {
          console.error('Failed to create Swypt ticket:', ticketError.message, ticketError.response?.data || {});
        }
      }
    });
  } catch (error) {
    console.error('Error in buyInsurance:', {
      message: error.message,
      code: error.code,
      transaction: error.transaction,
      receipt: error.receipt,
      reason: error.reason,
    });
    if (user && user.walletAddress) {
      try {
        await axios.post(
          'https://pool.swypt.io/api/user-onramp-ticket',
          {
            phone: formattedPhone,
            amount: amountKes.toString(),
            description: `Failed insurance purchase for premium ${premiumId} (${duration}): ${error.message}`,
            side: 'on-ramp',
            userAddress: user.walletAddress,
            symbol: 'cKES',
            tokenAddress: config.usdcAddress,
            chain: 'celo',
          },
          { headers: { 'x-api-key': process.env.SWYPT_API_KEY, 'x-api-secret': process.env.SWYPT_API_SECRET } }
        );
      } catch (ticketError) {
        console.error('Failed to create Swypt ticket:', ticketError.message, ticketError.response?.data || {});
      }
    }
    res.status(500).json({ message: 'Failed to initiate insurance purchase', error: error.message });
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
  });
};

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
    const receipt = await withdrawTx.wait();

    console.log('Fetching Swypt off-ramp quote...');
    const quoteResponse = await axios.post(
      `${config.swyptApiUrl}/swypt-quotes`,
      {
        type: 'offramp',
        amount: policy.amountUsdc,
        fiatCurrency: 'KES',
        cryptoCurrency: 'USDC',
        network: 'celo',
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
        chain: 'celo',
        hash: receipt.transactionHash,
        partyB: req.user.phone,
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

    const explorerLink = `https://alfajores-blockscout.celo-testnet.org/tx/${receipt.transactionHash}`;

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
        symbol: 'cUSD',
        tokenAddress: config.usdcAddress,
        chain: 'celo',
      },
      { headers: { 'x-api-key': process.env.SWYPT_API_KEY, 'x-api-secret': process.env.SWYPT_API_SECRET } }
    );
    res.status(500).json({ message: 'Failed to process claim', error: error.message });
  }
};