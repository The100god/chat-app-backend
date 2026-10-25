const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const GameGamificationConfig = require("../models/GameGamificationConfig");
const {
  getPairGamificationState,
  getUserGamification,
} = require("../services/gamificationService");

/**
 * GET /api/gamification/pair/:partnerId
 * Get pair progression, unlocked games, current level (1-20), and level configs
 */
router.get("/pair/:partnerId", protect, async (req, res) => {
  try {
    const currentUserId = req.user._id || req.user.id;
    const { partnerId } = req.params;

    if (!partnerId) {
      return res.status(400).json({ error: "Partner ID is required" });
    }

    const state = await getPairGamificationState(currentUserId, partnerId);
    if (!state) {
      return res.status(404).json({ error: "Failed to load pair gamification state" });
    }

    res.json({ success: true, data: state });
  } catch (err) {
    console.error("Error fetching pair gamification:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/gamification/config
 * Get all active games metadata and basic unlock rules
 */
router.get("/config", protect, async (req, res) => {
  try {
    const configs = await GameGamificationConfig.find({ enabled: true })
      .select("-levelConfigs.courtyardLayout.obstacles") // lightweight for initial listing
      .sort({ order: 1 })
      .lean();

    res.json({ success: true, data: configs });
  } catch (err) {
    console.error("Error fetching gamification config:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/gamification/me
 * Get current user's lifetime gamification stats
 */
router.get("/me", protect, async (req, res) => {
  try {
    const currentUserId = req.user._id || req.user.id;
    const stats = await getUserGamification(currentUserId);
    res.json({ success: true, data: stats });
  } catch (err) {
    console.error("Error fetching user gamification:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
