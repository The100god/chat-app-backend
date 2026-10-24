const GameGamificationConfig = require("../models/GameGamificationConfig");
const GamificationConfigVersion = require("../models/GamificationConfigVersion");

/**
 * Generate 20 level configs for a game with graduated difficulty and rewards
 */
function generate20LevelConfigs(gameId, baseTimeSec, gridOptions = {}) {
  const levels = [];

  for (let lvl = 1; lvl <= 20; lvl++) {
    // Timer decreases as level increases (clamped to a reasonable minimum)
    let timeSec = Math.max(5, Math.round(baseTimeSec - (lvl - 1) * 1.25));

    // Dynamic grid configuration based on game type and level
    let gridConfig = {};
    if (gameId === "memory") {
      let cardsCount = 12;
      if (lvl >= 16) cardsCount = 24;
      else if (lvl >= 11) cardsCount = 20;
      else if (lvl >= 6) cardsCount = 16;
      gridConfig = { cardsCount, pairsCount: cardsCount / 2 };
    } else if (gameId === "rps") {
      let bestOfRounds = 3;
      if (lvl >= 16) bestOfRounds = 9;
      else if (lvl >= 11) bestOfRounds = 7;
      else if (lvl >= 6) bestOfRounds = 5;
      gridConfig = { bestOfRounds };
    } else if (gameId === "connect4") {
      gridConfig = { rows: 6, cols: 7, winCondition: 4 };
    } else if (gameId === "quiz") {
      let questionsCount = 5;
      if (lvl >= 16) questionsCount = 10;
      else if (lvl >= 11) questionsCount = 8;
      else if (lvl >= 6) questionsCount = 7;
      gridConfig = { questionsCount };
    } else if (gameId === "tictactoe") {
      gridConfig = { size: 3 };
    } else if (gameId === "drawing") {
      gridConfig = { promptTimerSec: timeSec };
    }

    // Dynamic Courtyard Layout for Pakdam Pakdai (Tag)
    let courtyardLayout = {
      preset: "open_field",
      obstacles: [],
      catcherSpeed: 145 + lvl * 3,
      runnerSpeed: 155 + lvl * 3,
      powerUpSpawnRateSec: Math.max(5, 12 - Math.floor(lvl / 3)),
    };

    if (gameId === "catchpartner") {
      timeSec = Math.max(15, 35 - Math.floor((lvl - 1) * 1.0)); // Round time: 35s down to 15s
      if (lvl <= 4) {
        courtyardLayout.preset = "open_field";
        courtyardLayout.obstacles = [
          { x: 360, y: 240, w: 80, h: 120, type: "pillar" },
          { x: 180, y: 140, w: 100, h: 30, type: "wall" },
          { x: 520, y: 430, w: 100, h: 30, type: "wall" },
        ];
      } else if (lvl <= 8) {
        courtyardLayout.preset = "cross_corridors";
        courtyardLayout.obstacles = [
          { x: 350, y: 220, w: 100, h: 160, type: "pillar" },
          { x: 200, y: 100, w: 120, h: 40, type: "wall" },
          { x: 480, y: 460, w: 120, h: 40, type: "wall" },
          { x: 120, y: 380, w: 40, h: 120, type: "wall" },
          { x: 640, y: 100, w: 40, h: 120, type: "wall" },
        ];
      } else if (lvl <= 12) {
        courtyardLayout.preset = "maze_courtyard";
        courtyardLayout.obstacles = [
          { x: 200, y: 150, w: 40, h: 160, type: "wall" },
          { x: 560, y: 290, w: 40, h: 160, type: "wall" },
          { x: 380, y: 260, w: 80, h: 80, type: "pillar" },
          { x: 140, y: 450, w: 180, h: 35, type: "wall" },
          { x: 480, y: 110, w: 180, h: 35, type: "wall" },
          { x: 320, y: 120, w: 35, h: 100, type: "wall" },
          { x: 440, y: 380, w: 35, h: 100, type: "wall" },
        ];
      } else if (lvl <= 16) {
        courtyardLayout.preset = "fortress_citadel";
        courtyardLayout.obstacles = [
          { x: 150, y: 120, w: 120, h: 35, type: "wall" },
          { x: 530, y: 120, w: 120, h: 35, type: "wall" },
          { x: 150, y: 445, w: 120, h: 35, type: "wall" },
          { x: 530, y: 445, w: 120, h: 35, type: "wall" },
          { x: 370, y: 230, w: 60, h: 140, type: "pillar" },
          { x: 250, y: 270, w: 35, h: 100, type: "wall" },
          { x: 515, y: 230, w: 35, h: 100, type: "wall" },
          { x: 320, y: 410, w: 160, h: 30, type: "wall" },
          { x: 320, y: 160, w: 160, h: 30, type: "wall" },
        ];
      } else {
        courtyardLayout.preset = "grand_labyrinth";
        courtyardLayout.obstacles = [
          { x: 120, y: 100, w: 140, h: 30, type: "wall" },
          { x: 540, y: 100, w: 140, h: 30, type: "wall" },
          { x: 120, y: 470, w: 140, h: 30, type: "wall" },
          { x: 540, y: 470, w: 140, h: 30, type: "wall" },
          { x: 220, y: 200, w: 30, h: 160, type: "wall" },
          { x: 550, y: 240, w: 30, h: 160, type: "wall" },
          { x: 370, y: 160, w: 60, h: 80, type: "pillar" },
          { x: 370, y: 360, w: 60, h: 80, type: "pillar" },
          { x: 310, y: 275, w: 180, h: 35, type: "wall" },
          { x: 100, y: 310, w: 80, h: 30, type: "wall" },
          { x: 620, y: 260, w: 80, h: 30, type: "wall" },
        ];
      }
    }

    // Scaled rewards
    const participationPoints = 20 + Math.floor(lvl * 1.5);
    const winBonusPoints = 50 + lvl * 5;

    levels.push({
      level: lvl,
      title: `Level ${lvl}`,
      description: `Difficulty tier ${lvl} challenge`,
      timeSec,
      gridConfig,
      courtyardLayout,
      rewards: {
        participationPoints,
        winBonusPoints,
      },
    });
  }

  return levels;
}

const DEFAULT_GAMES_METADATA = [
  {
    gameId: "tictactoe",
    title: "Tic Tac Toe",
    category: "classic",
    icon: "grid",
    description: "Classic 3x3 strategy game. Easy to learn, quick to play!",
    isStarter: true,
    enabled: true,
    order: 1,
    rules: {
      participationPoints: 20,
      winBonusPoints: 50,
      streakBonusMultiplier: 1.1,
      requiredEligiblePlaySec: 4,
      minMovesBeforeComplete: 1,
    },
    unlockRequirements: {
      pointsRequired: 0,
      requiredPreviousGames: [],
    },
    startingLevel: 1,
    maximumLevel: 20,
    baseTimeSec: 30,
  },
  {
    gameId: "rps",
    title: "Rock Paper Scissors",
    category: "casual",
    icon: "hand",
    description: "Rock beats scissors, scissors beats paper, paper beats rock!",
    isStarter: false,
    enabled: true,
    order: 2,
    rules: {
      participationPoints: 25,
      winBonusPoints: 60,
      streakBonusMultiplier: 1.15,
      requiredEligiblePlaySec: 4,
      minMovesBeforeComplete: 1,
    },
    unlockRequirements: {
      pointsRequired: 100,
      requiredPreviousGames: [{ gameId: "tictactoe", minWins: 1, minPlays: 1 }],
    },
    startingLevel: 1,
    maximumLevel: 20,
    baseTimeSec: 15,
  },
  {
    gameId: "connect4",
    title: "Connect 4",
    category: "classic",
    icon: "disc",
    description: "Drop tokens into the grid and connect 4 of your color to win!",
    isStarter: false,
    enabled: true,
    order: 3,
    rules: {
      participationPoints: 30,
      winBonusPoints: 75,
      streakBonusMultiplier: 1.2,
      requiredEligiblePlaySec: 8,
      minMovesBeforeComplete: 2,
    },
    unlockRequirements: {
      pointsRequired: 250,
      requiredPreviousGames: [{ gameId: "tictactoe", minWins: 2, minPlays: 3 }],
    },
    startingLevel: 1,
    maximumLevel: 20,
    baseTimeSec: 30,
  },
  {
    gameId: "memory",
    title: "Memory Match",
    category: "mind",
    icon: "sparkles",
    description: "Test your memory together by finding pairs of hidden cards!",
    isStarter: false,
    enabled: true,
    order: 4,
    rules: {
      participationPoints: 35,
      winBonusPoints: 90,
      streakBonusMultiplier: 1.25,
      requiredEligiblePlaySec: 10,
      minMovesBeforeComplete: 2,
    },
    unlockRequirements: {
      pointsRequired: 500,
      requiredPreviousGames: [{ gameId: "connect4", minWins: 2, minPlays: 3 }],
    },
    startingLevel: 1,
    maximumLevel: 20,
    baseTimeSec: 25,
  },
  {
    gameId: "quiz",
    title: "Trivia Quiz",
    category: "mind",
    icon: "help-circle",
    description: "Answer fun couple questions and trivia together to test compatibility!",
    isStarter: false,
    enabled: true,
    order: 5,
    rules: {
      participationPoints: 40,
      winBonusPoints: 100,
      streakBonusMultiplier: 1.25,
      requiredEligiblePlaySec: 10,
      minMovesBeforeComplete: 2,
    },
    unlockRequirements: {
      pointsRequired: 800,
      requiredPreviousGames: [{ gameId: "memory", minWins: 2, minPlays: 3 }],
    },
    startingLevel: 1,
    maximumLevel: 20,
    baseTimeSec: 30,
  },
  {
    gameId: "catchpartner",
    title: "Pakdam Pakdai (Tag)",
    category: "action",
    icon: "zap",
    description: "Real-time arena chase game! Dodge obstacles and tag your partner before time runs out!",
    isStarter: false,
    enabled: true,
    order: 6,
    rules: {
      participationPoints: 50,
      winBonusPoints: 120,
      streakBonusMultiplier: 1.3,
      requiredEligiblePlaySec: 8,
      minMovesBeforeComplete: 1,
    },
    unlockRequirements: {
      pointsRequired: 1200,
      requiredPreviousGames: [
        { gameId: "tictactoe", minWins: 3, minPlays: 5 },
        { gameId: "connect4", minWins: 2, minPlays: 3 },
      ],
    },
    startingLevel: 1,
    maximumLevel: 20,
    baseTimeSec: 35,
  },
  {
    gameId: "drawing",
    title: "Drawing Canvas & Guess",
    category: "creative",
    icon: "edit-3",
    description: "Draw, doodle, and guess what your partner is creating in real time!",
    isStarter: false,
    enabled: true,
    order: 7,
    rules: {
      participationPoints: 40,
      winBonusPoints: 80,
      streakBonusMultiplier: 1.2,
      requiredEligiblePlaySec: 10,
      minMovesBeforeComplete: 2,
    },
    unlockRequirements: {
      pointsRequired: 1600,
      requiredPreviousGames: [{ gameId: "catchpartner", minWins: 2, minPlays: 4 }],
    },
    startingLevel: 1,
    maximumLevel: 20,
    baseTimeSec: 60,
  },
];

/**
 * Seed initial gamification configurations if none exist
 */
async function seedGamificationConfigs() {
  try {
    const existingCount = await GameGamificationConfig.countDocuments();
    if (existingCount > 0) {
      return;
    }

    console.log("🌱 Seeding initial Together Gamification configs (7 games, 20 levels each)...");

    const createdConfigs = [];

    for (const meta of DEFAULT_GAMES_METADATA) {
      const levelConfigs = generate20LevelConfigs(meta.gameId, meta.baseTimeSec);

      const configDoc = await GameGamificationConfig.create({
        gameId: meta.gameId,
        title: meta.title,
        category: meta.category,
        icon: meta.icon,
        description: meta.description,
        isStarter: meta.isStarter,
        enabled: meta.enabled,
        order: meta.order,
        rules: meta.rules,
        unlockRequirements: meta.unlockRequirements,
        startingLevel: meta.startingLevel,
        maximumLevel: meta.maximumLevel,
        levelConfigs,
        updatedBy: "system_seeder",
      });

      createdConfigs.push(configDoc.toObject());
    }

    // Create Initial Version 1
    await GamificationConfigVersion.create({
      version: 1,
      status: "published",
      publishedAt: new Date(),
      publishedBy: "system_seeder",
      snapshot: createdConfigs,
      changelog: "Initial bootstrap of 7 Together Games with 20 levels each",
    });

    console.log("✅ Together Gamification system successfully seeded with Version 1!");
  } catch (err) {
    console.error("❌ Error seeding gamification configs:", err);
  }
}

module.exports = {
  seedGamificationConfigs,
  generate20LevelConfigs,
  DEFAULT_GAMES_METADATA,
};
