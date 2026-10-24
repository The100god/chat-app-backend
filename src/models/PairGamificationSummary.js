const mongoose = require("mongoose");

const PairGamificationSummarySchema = new mongoose.Schema(
  {
    pairId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    memberUserIds: {
      type: [String],
      required: true,
      index: true,
    },
    totalCombinedPoints: {
      type: Number,
      default: 0,
    },
    totalCombinedWins: {
      type: Number,
      default: 0,
    },
    totalCombinedPlays: {
      type: Number,
      default: 0,
    },
    unlockedGamesCount: {
      type: Number,
      default: 1,
    },
    currentStreak: {
      type: Number,
      default: 0,
    },
    highestStreak: {
      type: Number,
      default: 0,
    },
    lastPlayedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model(
  "PairGamificationSummary",
  PairGamificationSummarySchema
);
