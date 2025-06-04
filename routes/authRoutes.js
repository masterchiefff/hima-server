const express = require('express');
const router = express.Router();
const authController = require('../controllers/authControllers');
const authenticate = require('../middleware/authenticate');

router.post('/request-otp', authController.requestOtp);
router.post('/verify-otp', authController.verifyOtp);
router.post('/register-complete', authController.registerComplete);
router.get('/get-user', authenticate,authController.getUser);

module.exports = router;