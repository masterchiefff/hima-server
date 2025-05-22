const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  otpHash: String,
  otpExpires: Date,
  motorcycle: {
    type: String,
    licensePlate: String,
    model: String,
    year: Number,
    engineCapacity: Number,
  },
  walletAddress: String,
  privateKey: String,
  privateKeyIV: { type: String },
});

module.exports = mongoose.model('User', userSchema);