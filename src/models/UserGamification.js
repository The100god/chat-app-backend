const mongoose = require("mongoose");

const UserGamificationSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    lifetimeEarnedPoints: {
      type: Number,
      default: 0,
    },
    lifetimeWins: {
      type: Number,
      default: 0,
    },
    lifetimePlays: {
      type: Number,
      default: 0,
    },
    topGameId: {
      type: String,
      default: "tictactoe",
    },
    pairsPlayedCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("UserGamification", UserGamificationSchema);
