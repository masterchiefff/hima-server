const express = require('express');
const router = express.Router();
const policyController = require('../controllers/poliicyController');
const authenticate = require('../middleware/authenticate');

router.post('/buy-insurance', authenticate, policyController.buyInsurance);
router.get('/policies', authenticate, policyController.getPolicies);
router.post('/mpesa-callback', policyController.mpesaCallback);
router.post('/claim', authenticate, policyController.claimPolicy);
router.get('/get-premiums', authenticate, policyController.getPremiums);
router.get("/status/:orderID", authenticate, policyController.getPolicyStatus);
router.get('/test', authenticate, policyController.test);

module.exports = router;