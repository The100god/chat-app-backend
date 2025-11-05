const express = require("express");
const {login, signup, googleAuth, verifyEmail, resendVerification} = require("../controllers/authController");

const router = express.Router()

router.post("/login", login)
router.post("/signup", signup)
router.get("/verify-email/:token", verifyEmail);
router.post("/google-login", googleAuth);
router.post("/resend-verification", resendVerification);


module.exports = router;