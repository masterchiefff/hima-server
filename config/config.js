const isProduction = process.env.NODE_ENV === 'production';
const baseUrl = isProduction
  ? process.env.RENDER_BASE_URL || 'https://hima-server.onrender.com/api/v1'
  : 'http://localhost:5000/api/v1';

const config = {
  baseUrl,
  mongoUri: process.env.MONGO_URI,
  port: process.env.PORT || 5000,
  jwtSecret: process.env.JWT_SECRET,
  swyptApiUrl: process.env.SWYPT_API_URL,
  mpesaApiUrl: process.env.MPESA_API_URL,
  africastalkingUsername: process.env.AFRICASTALKING_USERNAME,
  africastalkingApiKey: process.env.AFRICASTALKING_API_KEY,
  africastalkingSenderId: process.env.AFRICASTALKING_SENDER_ID,
  liskRpc: process.env.LISK_RPC_URL,
  liskPrivateKey: process.env.LISK_PRIVATE_KEY,
  escrowContractAddress: process.env.ESCROW_CONTRACT_ADDRESS,
  usdcAddress: process.env.USDC_ADDRESS,
  encryptionKey: process.env.ENCRYPTION_KEY,
  feeCurrecyAdapter: process.env.FEE_CURRENCY_ADAPTER || 'usdc',
};

module.exports = config;