const express = require('express');
const router = express.Router();
const authController = require('../controllers/authControllers');

router.post('/request-otp', authController.requestOtp);
router.post('/verify-otp', authController.verifyOtp);
router.post('/register-complete', authController.registerComplete);

module.exports = router;