const express = require('express');
const router = express.Router();
const policyController = require('../controllers/poliicyController');
const authenticate = require('../middleware/authenticate');

router.post('/buy-insurance', authenticate, policyController.buyInsurance);
router.get('/policies', authenticate, policyController.getPolicies);
router.post('/mpesa-callback', policyController.mpesaCallback);
router.post('/claim', authenticate, policyController.claimPolicy);

module.exports = router;