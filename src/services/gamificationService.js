const crypto = require("crypto");
const GameGamificationConfig = require("../models/GameGamificationConfig");
const PairGameProgress = require("../models/PairGameProgress");
const PairGamificationSummary = require("../models/PairGamificationSummary");
const UserGamification = require("../models/UserGamification");
const PointTransaction = require("../models/PointTransaction");

/**
 * Return consistent canonical pair ID regardless of user order.
 * e.g. "user_123:user_456"
 */
function getCanonicalPairId(id1, id2) {
  if (!id1 || !id2) return null;
  return [String(id1), String(id2)].sort().join(":");
}

/**
 * Normalize game ID (e.g. pakdam_pakdai -> catchpartner)
 */
function normalizeGameId(gameId) {
  if (!gameId) return "tictactoe";
  const lower = String(gameId).toLowerCase().trim();
  if (lower === "pakdam_pakdai" || lower === "pakdampakdai" || lower === "tag") {
    return "catchpartner";
  }
  return lower;
}

/**
 * Get level config for a game (1-20)
 */
async function getGameLevelConfig(gameId, level = 1) {
  const normId = normalizeGameId(gameId);
  const config = await GameGamificationConfig.findOne({ gameId: normId, enabled: true }).lean();
  if (!config || !Array.isArray(config.levelConfigs) || config.levelConfigs.length === 0) {
    return {
      level: 1,
      timeSec: 30,
      gridConfig: {},
      courtyardLayout: {
        preset: "open_field",
        obstacles: [],
        catcherSpeed: 150,
        runnerSpeed: 160,
        powerUpSpawnRateSec: 10,
      },
      rewards: { participationPoints: 20, winBonusPoints: 50 },
    };
  }

  const targetLevel = Math.max(1, Math.min(config.maximumLevel || 20, Number(level) || 1));
  const found = config.levelConfigs.find((l) => l.level === targetLevel);
  return (
    found ||
    config.levelConfigs[0] || {
      level: 1,
      timeSec: 30,
      gridConfig: {},
      courtyardLayout: { preset: "open_field", obstacles: [], catcherSpeed: 150, runnerSpeed: 160 },
      rewards: { participationPoints: 20, winBonusPoints: 50 },
    }
  );
}

/**
 * Evaluate unlocks for a pair against active game requirements.
 * Unlocks games if pair meets point thresholds and prerequisite wins.
 */
async function evaluatePairUnlocks(pairId, memberUserIds) {
  const allConfigs = await GameGamificationConfig.find({ enabled: true })
    .sort({ order: 1 })
    .lean();
  let summary = await PairGamificationSummary.findOne({ pairId });

  if (!summary) {
    summary = await PairGamificationSummary.create({
      pairId,
      memberUserIds,
      totalCombinedPoints: 0,
      totalCombinedWins: 0,
      totalCombinedPlays: 0,
      unlockedGamesCount: 1,
    });
  }

  const progressList = await PairGameProgress.find({ pairId }).lean();
  const progressMap = new Map();
  progressList.forEach((p) => progressMap.set(p.gameId, p));

  const newlyUnlocked = [];

  for (const gameConfig of allConfigs) {
    let progress = progressMap.get(gameConfig.gameId);

    if (!progress) {
      // Create initial progress doc
      const isStarter = !!gameConfig.isStarter;
      const created = await PairGameProgress.create({
        pairId,
        gameId: gameConfig.gameId,
        memberUserIds,
        currentLevel: 1,
        highestLevelAchieved: 1,
        isUnlocked: isStarter,
        unlockedAt: isStarter ? new Date() : null,
        combinedEligiblePoints: 0,
        combinedWins: 0,
        combinedPlays: 0,
      });
      progress = created.toObject();
      progressMap.set(gameConfig.gameId, progress);
    }

    if (progress.isUnlocked) {
      continue;
    }

    // Starter game is always unlocked
    if (gameConfig.isStarter) {
      await PairGameProgress.updateOne(
        { pairId, gameId: gameConfig.gameId },
        { $set: { isUnlocked: true, unlockedAt: new Date() } }
      );
      progress.isUnlocked = true;
      newlyUnlocked.push({ gameId: gameConfig.gameId, title: gameConfig.title });
      continue;
    }

    // Check points requirement
    const pointsNeeded = gameConfig.unlockRequirements?.pointsRequired || 0;
    const hasEnoughPoints = summary.totalCombinedPoints >= pointsNeeded;

    // Check prerequisite games requirement
    let prereqsMet = true;
    const prereqs = gameConfig.unlockRequirements?.requiredPreviousGames || [];
    for (const req of prereqs) {
      const prevProgress = progressMap.get(req.gameId);
      const reqWins = req.minWins || 0;
      const reqPlays = req.minPlays || 0;

      const actualWins = prevProgress?.combinedWins || 0;
      const actualPlays = prevProgress?.combinedPlays || 0;

      if (actualWins < reqWins || actualPlays < reqPlays) {
        prereqsMet = false;
        break;
      }
    }

    if (hasEnoughPoints && prereqsMet) {
      await PairGameProgress.updateOne(
        { pairId, gameId: gameConfig.gameId },
        { $set: { isUnlocked: true, unlockedAt: new Date() } }
      );
      progress.isUnlocked = true;
      newlyUnlocked.push({ gameId: gameConfig.gameId, title: gameConfig.title });
    }
  }

  // Update unlocked games count in summary
  const totalUnlocked = await PairGameProgress.countDocuments({
    pairId,
    isUnlocked: true,
  });

  if (summary.unlockedGamesCount !== totalUnlocked) {
    summary.unlockedGamesCount = totalUnlocked;
    await summary.save();
  }

  return { newlyUnlocked, totalUnlocked };
}

/**
 * Get comprehensive pair game progress, unlocked state, and level info
 */
async function getPairGamificationState(userA, userB) {
  const pairId = getCanonicalPairId(userA, userB);
  if (!pairId) return null;

  const memberUserIds = [String(userA), String(userB)];

  // 1. Evaluate & guarantee unlock states
  await evaluatePairUnlocks(pairId, memberUserIds);

  // 2. Fetch fresh data
  const summary = await PairGamificationSummary.findOne({ pairId }).lean();
  const progressList = await PairGameProgress.find({ pairId }).lean();
  const configs = await GameGamificationConfig.find({ enabled: true })
    .sort({ order: 1 })
    .lean();

  const progressMap = new Map();
  progressList.forEach((p) => progressMap.set(p.gameId, p));

  // Check if we need to hydrate historical userWins from PointTransaction
  const hasRecordedWins = progressList.some(
    (p) => p.userWins && Object.keys(p.userWins).length > 0
  );
  if (!hasRecordedWins) {
    try {
      const winTx = await PointTransaction.aggregate([
        { $match: { pairId, type: "win_bonus" } },
        { $group: { _id: { gameId: "$gameId", userId: "$userId" }, count: { $sum: 1 } } },
      ]);
      if (winTx && winTx.length > 0) {
        winTx.forEach((row) => {
          const gId = row._id.gameId;
          const uId = String(row._id.userId);
          const prog = progressMap.get(gId);
          if (prog) {
            if (!prog.userWins) prog.userWins = {};
            prog.userWins[uId] = row.count;
          }
        });
      }
    } catch (e) {
      // non-blocking
    }
  }

  const uA = String(userA);
  const uB = String(userB);

  const games = configs.map((cfg) => {
    const prog = progressMap.get(cfg.gameId);
    const currentLevel = prog?.currentLevel || 1;
    const currentLvlConfig =
      cfg.levelConfigs?.find((l) => l.level === currentLevel) ||
      cfg.levelConfigs?.[0] ||
      {};

    const userWinsMap = prog?.userWins || {};
    const myWins = Number(userWinsMap[uA] || 0);
    const partnerWins = Number(userWinsMap[uB] || 0);
    const ties = Number(prog?.ties || 0);
    const totalPlays = prog?.combinedPlays || (myWins + partnerWins + ties);

    return {
      gameId: cfg.gameId,
      title: cfg.title,
      category: cfg.category,
      icon: cfg.icon,
      description: cfg.description,
      isStarter: !!cfg.isStarter,
      order: cfg.order,
      isUnlocked: !!prog?.isUnlocked,
      unlockedAt: prog?.unlockedAt || null,
      currentLevel,
      highestLevelAchieved: prog?.highestLevelAchieved || 1,
      maximumLevel: cfg.maximumLevel || 20,
      combinedPoints: prog?.combinedEligiblePoints || 0,
      combinedWins: prog?.combinedWins || 0,
      combinedPlays: totalPlays,
      pairStats: {
        myWins,
        partnerWins,
        ties,
        totalPlays,
      },
      userWins: userWinsMap,
      ties,
      lastPlayedAt: prog?.lastPlayedAt || null,
      unlockRequirements: {
        pointsRequired: cfg.unlockRequirements?.pointsRequired || 0,
        requiredPreviousGames: cfg.unlockRequirements?.requiredPreviousGames || [],
      },
      currentLevelConfig: {
        level: currentLevel,
        title: currentLvlConfig.title || `Level ${currentLevel}`,
        timeSec: currentLvlConfig.timeSec || 30,
        gridConfig: currentLvlConfig.gridConfig || {},
        courtyardLayout: currentLvlConfig.courtyardLayout || null,
        rewards: currentLvlConfig.rewards || cfg.rules,
      },
    };
  });

  const sumWinsMap = summary?.userWins || {};
  let myTotalWins = Number(sumWinsMap[uA] || 0);
  let partnerTotalWins = Number(sumWinsMap[uB] || 0);
  let totalTies = Number(summary?.totalCombinedTies || 0);

  // If summary userWins wasn't populated yet, aggregate from games
  if (myTotalWins === 0 && partnerTotalWins === 0) {
    games.forEach((g) => {
      myTotalWins += g.pairStats.myWins;
      partnerTotalWins += g.pairStats.partnerWins;
      totalTies += g.pairStats.ties;
    });
  }

  return {
    pairId,
    memberUserIds,
    summary: {
      totalCombinedPoints: summary?.totalCombinedPoints || 0,
      totalCombinedWins: summary?.totalCombinedWins || (myTotalWins + partnerTotalWins),
      totalCombinedPlays: summary?.totalCombinedPlays || 0,
      myTotalWins,
      partnerTotalWins,
      totalTies,
      unlockedGamesCount: summary?.unlockedGamesCount || 1,
      currentStreak: summary?.currentStreak || 0,
      highestStreak: summary?.highestStreak || 0,
      lastPlayedAt: summary?.lastPlayedAt || null,
    },
    games,
  };
}

/**
 * Process match completion with server verification, idempotency,
 * pair progress updating, level-up calculation (1 to 20), point ledger recording, and unlock checks.
 */
async function processMatchCompletion({
  roomId,
  matchId,
  gameId,
  participants = [],
  winnerId = null,
  isDraw = false,
  durationSec = 10,
  movesCount = 1,
  metadata = {},
}) {
  try {
    const normGameId = normalizeGameId(gameId);

    if (!participants || participants.length < 2) {
      return { error: "At least 2 participants required for pair progression" };
    }

    const [userA, userB] = participants;
    const pairId = getCanonicalPairId(userA, userB);
    if (!pairId) return { error: "Invalid participants for pairId" };

    const generatedMatchId =
      matchId || `match_${roomId || "room"}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;

    // 1. Check idempotency: Have points already been awarded for this match?
    const existingTx = await PointTransaction.findOne({ matchId: generatedMatchId });
    if (existingTx) {
      console.log(`[Gamification] Match ${generatedMatchId} was already processed. Returning.`);
      const summary = await PairGamificationSummary.findOne({ pairId }).lean();
      const progress = await PairGameProgress.findOne({ pairId, gameId: normGameId }).lean();
      return {
        alreadyProcessed: true,
        matchId: generatedMatchId,
        pairId,
        gameId: normGameId,
        currentLevel: progress?.currentLevel || 1,
        totalCombinedPoints: summary?.totalCombinedPoints || 0,
      };
    }

    // 2. Fetch game configuration & current level for pair
    const gameConfig = await GameGamificationConfig.findOne({ gameId: normGameId }).lean();
    if (!gameConfig) {
      return { error: `Configuration for game ${normGameId} not found` };
    }

    let progress = await PairGameProgress.findOne({ pairId, gameId: normGameId });
    if (!progress) {
      progress = await PairGameProgress.create({
        pairId,
        gameId: normGameId,
        memberUserIds: [String(userA), String(userB)],
        currentLevel: 1,
        highestLevelAchieved: 1,
        isUnlocked: true,
        unlockedAt: new Date(),
        combinedEligiblePoints: 0,
        combinedWins: 0,
        combinedPlays: 0,
      });
    }

    const currentLevel = Math.max(1, Math.min(gameConfig.maximumLevel || 20, progress.currentLevel || 1));
    const levelConfig =
      gameConfig.levelConfigs?.find((l) => l.level === currentLevel) ||
      gameConfig.levelConfigs?.[0] ||
      {};

    const participationPts =
      levelConfig.rewards?.participationPoints || gameConfig.rules?.participationPoints || 20;
    const winBonusPts =
      levelConfig.rewards?.winBonusPoints || gameConfig.rules?.winBonusPoints || 50;

    const rewardBreakdown = {};
    let totalMatchPoints = 0;

    // 3. Award points & create ledger records for each participant
    for (const pId of [String(userA), String(userB)]) {
      const isWinner = winnerId && String(winnerId) === String(pId);
      const earnedParticipation = participationPts;
      const earnedWinBonus = isWinner ? winBonusPts : 0;
      const userTotalEarned = earnedParticipation + earnedWinBonus;
      totalMatchPoints += userTotalEarned;

      rewardBreakdown[pId] = {
        userId: pId,
        participation: earnedParticipation,
        winBonus: earnedWinBonus,
        isWinner: !!isWinner,
        totalEarned: userTotalEarned,
      };

      // Create participation transaction
      await PointTransaction.create({
        transactionId: `tx_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
        matchId: generatedMatchId,
        pairId,
        userId: pId,
        gameId: normGameId,
        type: "participation",
        points: earnedParticipation,
        levelAtMatch: currentLevel,
        metadata: {
          roomId,
          opponentId: String(pId) === String(userA) ? String(userB) : String(userA),
          durationSec,
          movesCount,
          ...metadata,
        },
      });

      // Create win bonus transaction if winner
      if (isWinner) {
        await PointTransaction.create({
          transactionId: `tx_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
          matchId: generatedMatchId,
          pairId,
          userId: pId,
          gameId: normGameId,
          type: "win_bonus",
          points: earnedWinBonus,
          levelAtMatch: currentLevel,
          metadata: {
            roomId,
            durationSec,
            ...metadata,
          },
        });
      }

      // Update UserGamification lifetime stats
      await UserGamification.findOneAndUpdate(
        { userId: pId },
        {
          $inc: {
            lifetimeEarnedPoints: userTotalEarned,
            lifetimePlays: 1,
            lifetimeWins: isWinner ? 1 : 0,
          },
          $set: { topGameId: normGameId },
        },
        { upsert: true, new: true }
      );
    }

    // 4. Update PairGameProgress & calculate level-up
    const prevLevel = progress.currentLevel;
    let newLevel = prevLevel;
    let leveledUp = false;

    // Winning a game increases that game's level/difficulty (Levels 1 to 20)
    if (winnerId && !isDraw) {
      if (prevLevel < (gameConfig.maximumLevel || 20)) {
        newLevel = prevLevel + 1;
        leveledUp = true;
      }
    }

    const currentLevelStats = progress.levelStats || {};
    const lvlKey = String(currentLevel);
    const existingLvlStat = currentLevelStats[lvlKey] || { plays: 0, wins: 0 };
    currentLevelStats[lvlKey] = {
      plays: existingLvlStat.plays + 1,
      wins: existingLvlStat.wins + (winnerId ? 1 : 0),
    };

    progress.combinedEligiblePoints += totalMatchPoints;
    progress.combinedPlays += 1;
    if (winnerId && !isDraw) {
      progress.combinedWins += 1;
      const wIdStr = String(winnerId);
      const uWins = progress.userWins || {};
      uWins[wIdStr] = (uWins[wIdStr] || 0) + 1;
      progress.userWins = uWins;
      progress.markModified("userWins");
    } else if (isDraw) {
      progress.ties = (progress.ties || 0) + 1;
    }

    progress.currentLevel = newLevel;
    if (newLevel > progress.highestLevelAchieved) {
      progress.highestLevelAchieved = newLevel;
    }
    progress.lastPlayedAt = new Date();
    progress.levelStats = currentLevelStats;
    await progress.save();

    // 5. Update PairGamificationSummary
    const summaryUpdate = {
      $inc: {
        totalCombinedPoints: totalMatchPoints,
        totalCombinedPlays: 1,
      },
      $set: { lastPlayedAt: new Date() },
    };

    if (winnerId && !isDraw) {
      summaryUpdate.$inc.totalCombinedWins = 1;
      const wIdStr = String(winnerId);
      summaryUpdate.$inc[`userWins.${wIdStr}`] = 1;
    } else if (isDraw) {
      summaryUpdate.$inc.totalCombinedTies = 1;
    }

    const summary = await PairGamificationSummary.findOneAndUpdate(
      { pairId },
      summaryUpdate,
      { upsert: true, new: true }
    );

    // 6. Evaluate game unlocks based on updated pair totals
    const { newlyUnlocked } = await evaluatePairUnlocks(pairId, [
      String(userA),
      String(userB),
    ]);

    return {
      success: true,
      matchId: generatedMatchId,
      pairId,
      gameId: normGameId,
      rewards: rewardBreakdown,
      totalMatchPoints,
      levelInfo: {
        previousLevel: prevLevel,
        currentLevel: newLevel,
        leveledUp,
        maximumLevel: gameConfig.maximumLevel || 20,
      },
      pairTotals: {
        totalCombinedPoints: summary.totalCombinedPoints,
        totalCombinedWins: summary.totalCombinedWins,
        totalCombinedPlays: summary.totalCombinedPlays,
      },
      newlyUnlockedGames: newlyUnlocked,
    };
  } catch (err) {
    console.error("❌ Error processing gamification match completion:", err);
    return { error: err.message };
  }
}

/**
 * Get individual user lifetime gamification metrics
 */
async function getUserGamification(userId) {
  if (!userId) return null;
  let userStats = await UserGamification.findOne({ userId: String(userId) }).lean();
  if (!userStats) {
    userStats = {
      userId: String(userId),
      lifetimeEarnedPoints: 0,
      lifetimeWins: 0,
      lifetimePlays: 0,
      topGameId: "tictactoe",
      pairsPlayedCount: 0,
    };
  }
  return userStats;
}

module.exports = {
  getCanonicalPairId,
  normalizeGameId,
  getGameLevelConfig,
  evaluatePairUnlocks,
  getPairGamificationState,
  processMatchCompletion,
  getUserGamification,
};
