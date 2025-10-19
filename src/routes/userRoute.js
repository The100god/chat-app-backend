// routes/userRoute.js
const express = require("express");
const router = express.Router();
const { searchUsersByUsername, getUserProfile, updateUserProfile  } = require("../controllers/userController");
const { protect, changePasswordLimiter } = require("../middleware/authMiddleware");
const { changePassword } = require("../controllers/authController");

router.get("/search", searchUsersByUsername); // Search users by username
// Get logged-in user profile
router.get("/me", protect, getUserProfile);

// Update logged-in user profile
router.put("/updateProfile", protect, updateUserProfile);

// Change password route can be added here
router.put("/changePassword", protect, changePasswordLimiter, changePassword)
module.exports = router;
