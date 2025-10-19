const express = require("express");
const router = express.Router();
const { sendFriendRequest, respondToFriendRequest, getFriends, removeFriend,getFriendRequests } = require('../controllers/friendController');

router.post('/send-request', sendFriendRequest);
router.post('/respond-request', respondToFriendRequest);
router.get('/get-friends/:userId', getFriends);
router.post('/remove-friend', removeFriend);
router.get('/friend-requests/:userId', getFriendRequests);

module.exports = router;