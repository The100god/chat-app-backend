const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { adminProtect } = require("../middleware/adminAuth");
const GameGamificationConfig = require("../models/GameGamificationConfig");
const GamificationConfigVersion = require("../models/GamificationConfigVersion");
const PointTransaction = require("../models/PointTransaction");
const PairGamificationSummary = require("../models/PairGamificationSummary");
const PairGameProgress = require("../models/PairGameProgress");
const UserGamification = require("../models/UserGamification");
const { generate20LevelConfigs } = require("../utils/gamificationSeeder");

/**
 * GET /api/admin/gamification/config
 * Return all game gamification configurations with their complete 20 level matrices
 */
router.get("/config", adminProtect, async (req, res) => {
  try {
    const configs = await GameGamificationConfig.find().sort({ order: 1 }).lean();
    const activeVersion = await GamificationConfigVersion.findOne({ status: "published" })
      .sort({ version: -1 })
      .lean();

    res.json({
      success: true,
      data: {
        configs,
        activeVersion: activeVersion ? activeVersion.version : 1,
        totalGames: configs.length,
      },
    });
  } catch (err) {
    console.error("Admin gamification fetch error:", err);
    res.status(500).json({ error: "Failed to fetch gamification configurations" });
  }
});

/**
 * PUT /api/admin/gamification/games/:gameId
 * Update an existing game configuration, rules, unlock requirements, or 20 level matrix
 */
router.put("/games/:gameId", adminProtect, async (req, res) => {
  try {
    const { gameId } = req.params;
    const updates = req.body;

    const existing = await GameGamificationConfig.findOne({ gameId });
    if (!existing) {
      return res.status(404).json({ error: `Game ${gameId} not found` });
    }

    // If making this game the starter game, unset isStarter on any other game
    if (updates.isStarter === true) {
      await GameGamificationConfig.updateMany(
        { gameId: { $ne: gameId } },
        { $set: { isStarter: false } }
      );
    }

    // Allowed fields
    if (updates.title !== undefined) existing.title = updates.title;
    if (updates.category !== undefined) existing.category = updates.category;
    if (updates.icon !== undefined) existing.icon = updates.icon;
    if (updates.description !== undefined) existing.description = updates.description;
    if (updates.enabled !== undefined) existing.enabled = updates.enabled;
    if (updates.isStarter !== undefined) existing.isStarter = updates.isStarter;
    if (updates.order !== undefined) existing.order = updates.order;
    if (updates.rules !== undefined) existing.rules = updates.rules;
    if (updates.unlockRequirements !== undefined)
      existing.unlockRequirements = updates.unlockRequirements;
    if (updates.startingLevel !== undefined)
      existing.startingLevel = updates.startingLevel;
    if (updates.maximumLevel !== undefined)
      existing.maximumLevel = updates.maximumLevel;
    if (Array.isArray(updates.levelConfigs))
      existing.levelConfigs = updates.levelConfigs;

    existing.updatedBy = req.admin?.username || "admin";
    existing.updatedAt = new Date();

    await existing.save();

    res.json({
      success: true,
      message: `Game ${gameId} updated successfully`,
      data: existing,
    });
  } catch (err) {
    console.error("Admin game update error:", err);
    res.status(500).json({ error: "Failed to update game configuration" });
  }
});

/**
 * POST /api/admin/gamification/games/:gameId/generate-curve
 * Automatically generates a balanced difficulty curve (Levels 1 to 20)
 * for time, grid, and courtyard obstacles
 */
router.post("/games/:gameId/generate-curve", adminProtect, async (req, res) => {
  try {
    const { gameId } = req.params;
    const { baseTimeSec = 30 } = req.body;

    const game = await GameGamificationConfig.findOne({ gameId });
    if (!game) {
      return res.status(404).json({ error: `Game ${gameId} not found` });
    }

    const newLevelConfigs = generate20LevelConfigs(gameId, Number(baseTimeSec) || 30);
    game.levelConfigs = newLevelConfigs;
    game.updatedBy = req.admin?.username || "admin";
    await game.save();

    res.json({
      success: true,
      message: `Generated 20-level difficulty curve for ${game.title}`,
      data: game.levelConfigs,
    });
  } catch (err) {
    console.error("Admin curve generator error:", err);
    res.status(500).json({ error: "Failed to generate difficulty curve" });
  }
});

/**
 * POST /api/admin/gamification/publish
 * Publish all current game configurations as an immutable version snapshot
 */
router.post("/publish", adminProtect, async (req, res) => {
  try {
    const { changelog = "Published gamification settings" } = req.body;
    const currentConfigs = await GameGamificationConfig.find().lean();

    const latestVersionDoc = await GamificationConfigVersion.findOne()
      .sort({ version: -1 })
      .lean();
    const nextVersion = (latestVersionDoc?.version || 0) + 1;

    // Archive previous versions
    await GamificationConfigVersion.updateMany(
      { status: "published" },
      { $set: { status: "archived" } }
    );

    const versionDoc = await GamificationConfigVersion.create({
      version: nextVersion,
      status: "published",
      publishedAt: new Date(),
      publishedBy: req.admin?.username || "admin",
      snapshot: currentConfigs,
      changelog,
    });

    res.json({
      success: true,
      message: `Successfully published version ${nextVersion}`,
      data: versionDoc,
    });
  } catch (err) {
    console.error("Admin publish error:", err);
    res.status(500).json({ error: "Failed to publish gamification version" });
  }
});

/**
 * GET /api/admin/gamification/versions
 * Get version history
 */
router.get("/versions", adminProtect, async (req, res) => {
  try {
    const versions = await GamificationConfigVersion.find()
      .select("-snapshot")
      .sort({ version: -1 })
      .lean();

    res.json({ success: true, data: versions });
  } catch (err) {
    console.error("Admin versions fetch error:", err);
    res.status(500).json({ error: "Failed to fetch version history" });
  }
});

/**
 * POST /api/admin/gamification/rollback/:version
 * Rollback current configurations to a historical snapshot
 */
router.post("/rollback/:version", adminProtect, async (req, res) => {
  try {
    const targetVersion = Number(req.params.version);
    const targetDoc = await GamificationConfigVersion.findOne({ version: targetVersion });
    if (!targetDoc || !targetDoc.snapshot) {
      return res.status(404).json({ error: `Version ${targetVersion} snapshot not found` });
    }

    // Overwrite configs from snapshot
    for (const snap of targetDoc.snapshot) {
      await GameGamificationConfig.findOneAndUpdate(
        { gameId: snap.gameId },
        { $set: snap },
        { upsert: true }
      );
    }

    // Mark target as active published
    await GamificationConfigVersion.updateMany({}, { $set: { status: "archived" } });
    targetDoc.status = "published";
    targetDoc.publishedAt = new Date();
    targetDoc.publishedBy = `${req.admin?.username || "admin"} (rollback)`;
    await targetDoc.save();

    res.json({
      success: true,
      message: `Successfully rolled back to version ${targetVersion}`,
    });
  } catch (err) {
    console.error("Admin rollback error:", err);
    res.status(500).json({ error: "Failed to rollback version" });
  }
});

const User = require("../models/User");

/**
 * GET /api/admin/gamification/pairs-and-users
 * Returns list of user pairs with names and combined points, plus users list for dropdowns
 */
router.get("/pairs-and-users", adminProtect, async (req, res) => {
  try {
    const [pairSummaries, allUsers] = await Promise.all([
      PairGamificationSummary.find().sort({ updatedAt: -1, totalCombinedPoints: -1 }).limit(100).lean(),
      User.find({}, "username name email profilePic").sort({ name: 1, username: 1 }).limit(200).lean(),
    ]);

    const userMap = new Map();
    allUsers.forEach((u) => {
      userMap.set(String(u._id), u);
    });

    const pairs = pairSummaries.map((ps) => {
      const [idA, idB] = (ps.pairId || "").split(":");
      const userA = userMap.get(String(idA)) || { _id: idA, username: "unknown", name: idA ? idA.slice(0, 8) : "User A" };
      const userB = userMap.get(String(idB)) || { _id: idB, username: "unknown", name: idB ? idB.slice(0, 8) : "User B" };
      const displayName = `${userA.name || `@${userA.username}`} & ${userB.name || `@${userB.username}`}`;

      return {
        pairId: ps.pairId,
        displayName,
        totalPoints: ps.totalCombinedPoints || 0,
        totalWins: ps.totalCombinedWins || 0,
        currentStreak: ps.currentStreak || 0,
        userA,
        userB,
        updatedAt: ps.updatedAt,
      };
    });

    res.json({
      success: true,
      data: {
        pairs,
        users: allUsers,
      },
    });
  } catch (err) {
    console.error("Fetch pairs and users error:", err);
    res.status(500).json({ error: "Failed to fetch pairs and users" });
  }
});

/**
 * GET /api/admin/gamification/ledger
 * View point transactions audit ledger with enriched user and pair names
 */
router.get("/ledger", adminProtect, async (req, res) => {
  try {
    const { page = 1, limit = 50, pairId, userId, gameId, type } = req.query;
    const filter = {};
    if (pairId) filter.pairId = pairId;
    if (userId) filter.userId = userId;
    if (gameId) filter.gameId = gameId;
    if (type) filter.type = type;

    const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
    const [transactions, total] = await Promise.all([
      PointTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      PointTransaction.countDocuments(filter),
    ]);

    // Gather distinct user IDs
    const userIdsSet = new Set();
    transactions.forEach((tx) => {
      if (tx.userId) userIdsSet.add(String(tx.userId));
      if (tx.pairId && tx.pairId.includes(":")) {
        const [idA, idB] = tx.pairId.split(":");
        if (idA) userIdsSet.add(String(idA));
        if (idB) userIdsSet.add(String(idB));
      }
    });

    const users = await User.find(
      { _id: { $in: Array.from(userIdsSet) } },
      "username name email profilePic"
    ).lean();

    const userMap = new Map();
    users.forEach((u) => {
      userMap.set(String(u._id), u);
    });

    const enrichedTransactions = transactions.map((tx) => {
      const u = userMap.get(String(tx.userId));
      let pairNames = tx.pairId;
      if (tx.pairId && tx.pairId.includes(":")) {
        const [idA, idB] = tx.pairId.split(":");
        const userA = userMap.get(String(idA));
        const userB = userMap.get(String(idB));
        const nameA = userA ? (userA.name || `@${userA.username}`) : idA.slice(0, 8);
        const nameB = userB ? (userB.name || `@${userB.username}`) : idB.slice(0, 8);
        pairNames = `${nameA} & ${nameB}`;
      }

      return {
        ...tx,
        userName: u ? (u.name || `@${u.username}`) : String(tx.userId),
        userUsername: u?.username || "",
        userEmail: u?.email || "",
        pairNames,
      };
    });

    res.json({
      success: true,
      data: {
        transactions: enrichedTransactions,
        total,
        page: Number(page),
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    console.error("Admin ledger fetch error:", err);
    res.status(500).json({ error: "Failed to fetch points ledger" });
  }
});

/**
 * POST /api/admin/gamification/adjust-points
 * Manually award or deduct points for a pair/user with audit logging
 */
router.post("/adjust-points", adminProtect, async (req, res) => {
  try {
    const { pairId, userId, points, reason = "Admin manual adjustment" } = req.body;

    if (!pairId || !userId || typeof points !== "number") {
      return res.status(400).json({ error: "pairId, userId, and numeric points are required" });
    }

    const txId = `tx_adj_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const matchId = `admin_adj_${Date.now()}`;

    // 1. Record transaction
    const tx = await PointTransaction.create({
      transactionId: txId,
      matchId,
      pairId,
      userId,
      gameId: "admin_adjustment",
      type: "admin_adjustment",
      points,
      levelAtMatch: 1,
      metadata: {
        adjustedBy: req.admin?.username || "admin",
        reason,
      },
    });

    // 2. Adjust Pair summary
    const summary = await PairGamificationSummary.findOneAndUpdate(
      { pairId },
      { $inc: { totalCombinedPoints: points } },
      { upsert: true, new: true }
    );

    // 3. Adjust User summary
    await UserGamification.findOneAndUpdate(
      { userId },
      { $inc: { lifetimeEarnedPoints: points } },
      { upsert: true }
    );

    res.json({
      success: true,
      message: `Successfully adjusted points by ${points}`,
      data: {
        transaction: tx,
        newPairTotal: summary.totalCombinedPoints,
      },
    });
  } catch (err) {
    console.error("Admin adjust points error:", err);
    res.status(500).json({ error: "Failed to adjust points" });
  }
});

module.exports = router;
