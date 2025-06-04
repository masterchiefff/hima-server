const mongoose = require('mongoose');

const policySchema = new mongoose.Schema({
  phone: { type: String, required: true },
  premiumId: { type: String, required: true },
  premiumName: { type: String, required: true },
  amountKes: { type: Number, required: true },
  amountCusd: String,
  duration: { type: String, enum: ['daily', 'weekly', 'monthly', 'annually'], required: true },
  coverage: {
    personalAccident: Boolean,
    medicalExpenses: { type: Boolean, default: false },
    thirdPartyInjury: { type: Boolean, default: false },
    motorcycleDamage: { type: Boolean, default: false },
    theftProtection: { type: Boolean, default: false },
  },
  status: { type: String, enum: ['Pending', 'Active', 'Claimed', 'Expired'], default: 'Pending' },
  mpesaStatus: { type: String, default: 'Pending' },
  mpesaResultDesc: String,
  orderID: String,
  transactionHash: { type: String }, 
  swyptDepositHash: { type: String }, 
  approveTxHash: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Policy', policySchema);