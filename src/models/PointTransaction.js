const mongoose = require("mongoose");

const PointTransactionSchema = new mongoose.Schema(
  {
    transactionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    matchId: {
      type: String,
      required: true,
      index: true,
    },
    pairId: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    gameId: {
      type: String,
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        "participation",
        "win_bonus",
        "streak_bonus",
        "admin_adjustment",
        "level_up_bonus",
      ],
      required: true,
    },
    points: {
      type: Number,
      required: true,
    },
    levelAtMatch: {
      type: Number,
      default: 1,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Idempotency: exact same match, user, and point type cannot be awarded twice
PointTransactionSchema.index({ matchId: 1, userId: 1, type: 1 }, { unique: true });

module.exports = mongoose.model("PointTransaction", PointTransactionSchema);
