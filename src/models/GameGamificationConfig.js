const mongoose = require("mongoose");

const CourtyardObstacleSchema = new mongoose.Schema(
  {
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    w: { type: Number, required: true },
    h: { type: Number, required: true },
    type: { type: String, default: "wall" }, // "wall", "pillar", "bush", "water"
  },
  { _id: false }
);

const GameLevelConfigSchema = new mongoose.Schema(
  {
    level: { type: Number, required: true, min: 1, max: 20 },
    title: { type: String, default: "" },
    description: { type: String, default: "" },
    timeSec: { type: Number, default: 30 }, // Timer per turn/round in seconds
    gridConfig: {
      type: mongoose.Schema.Types.Mixed,
      default: {}, // e.g. { rows: 6, cols: 7 }, { cardsCount: 12 }, { questionsCount: 5 }, etc.
    },
    courtyardLayout: {
      preset: { type: String, default: "open_field" },
      obstacles: { type: [CourtyardObstacleSchema], default: [] },
      catcherSpeed: { type: Number, default: 150 },
      runnerSpeed: { type: Number, default: 160 },
      powerUpSpawnRateSec: { type: Number, default: 10 },
    },
    rewards: {
      participationPoints: { type: Number, default: 20 },
      winBonusPoints: { type: Number, default: 50 },
    },
  },
  { _id: false }
);

const GameGamificationConfigSchema = new mongoose.Schema(
  {
    gameId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    category: {
      type: String,
      enum: ["classic", "casual", "mind", "action", "creative"],
      default: "classic",
    },
    icon: {
      type: String,
      default: "gamepad-2",
    },
    description: {
      type: String,
      default: "",
    },
    isStarter: {
      type: Boolean,
      default: false,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    order: {
      type: Number,
      default: 1,
    },
    rules: {
      participationPoints: { type: Number, default: 20 },
      winBonusPoints: { type: Number, default: 50 },
      streakBonusMultiplier: { type: Number, default: 1.0 },
      requiredEligiblePlaySec: { type: Number, default: 5 }, // Min duration to prevent fraud
      minMovesBeforeComplete: { type: Number, default: 1 },
    },
    unlockRequirements: {
      pointsRequired: { type: Number, default: 0 },
      requiredPreviousGames: [
        {
          gameId: { type: String, required: true },
          minWins: { type: Number, default: 0 },
          minPlays: { type: Number, default: 0 },
          _id: false,
        },
      ],
    },
    startingLevel: {
      type: Number,
      default: 1,
      min: 1,
      max: 20,
    },
    maximumLevel: {
      type: Number,
      default: 20,
      min: 1,
      max: 20,
    },
    levelConfigs: {
      type: [GameLevelConfigSchema],
      default: [],
    },
    updatedBy: {
      type: String,
      default: "system",
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model(
  "GameGamificationConfig",
  GameGamificationConfigSchema
);
