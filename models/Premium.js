const mongoose = require('mongoose');

const coverageSchema = new mongoose.Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
  included: { type: Boolean, required: true },
});

const premiumSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  description: { type: String, required: true },
  basePrice: { type: Number, required: true }, // Weekly base price in KES
  coverages: [coverageSchema],
});

module.exports = mongoose.model('Premium', premiumSchema);