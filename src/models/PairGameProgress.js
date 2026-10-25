const mongoose = require("mongoose");

const PairGameProgressSchema = new mongoose.Schema(
  {
    pairId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    gameId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    memberUserIds: {
      type: [String],
      required: true,
      index: true,
    },
    currentLevel: {
      type: Number,
      default: 1,
      min: 1,
      max: 20,
    },
    highestLevelAchieved: {
      type: Number,
      default: 1,
      min: 1,
      max: 20,
    },
    isUnlocked: {
      type: Boolean,
      default: false,
    },
    unlockedAt: {
      type: Date,
      default: null,
    },
    combinedEligiblePoints: {
      type: Number,
      default: 0,
    },
    combinedWins: {
      type: Number,
      default: 0,
    },
    combinedPlays: {
      type: Number,
      default: 0,
    },
    lastPlayedAt: {
      type: Date,
      default: null,
    },
    levelStats: {
      type: mongoose.Schema.Types.Mixed,
      default: {}, // e.g. { "1": { plays: 3, wins: 2 }, "2": { ... } }
    },
    userWins: {
      type: mongoose.Schema.Types.Mixed,
      default: {}, // e.g. { "userIdA": 3, "userIdB": 2 }
    },
    ties: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Enforce unique compound index so there is exactly one record per game per pair
PairGameProgressSchema.index({ pairId: 1, gameId: 1 }, { unique: true });

module.exports = mongoose.model("PairGameProgress", PairGameProgressSchema);
