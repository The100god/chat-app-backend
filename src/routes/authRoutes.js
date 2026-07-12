const express = require("express");
const {login, signup, googleAuth, verifyEmail, resendVerification, refreshTokenHandler} = require("../controllers/authController");

const router = express.Router()

router.post("/login", login)
router.post("/signup", signup)
router.get("/verify-email/:token", verifyEmail);
router.post("/google-login", googleAuth);
router.post("/resend-verification", resendVerification);
router.post("/refresh-token", refreshTokenHandler) // To be implemented

router.post("/logout", (req, res) => {
  res.clearCookie("refreshToken", {
    httpOnly: true,
    sameSite: "none",
    secure: true,
  });

  res.status(200).json({ message: "Logged out" });
});

module.exports = router;