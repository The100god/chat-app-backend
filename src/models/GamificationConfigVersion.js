const mongoose = require("mongoose");

const GamificationConfigVersionSchema = new mongoose.Schema(
  {
    version: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["draft", "published", "archived"],
      default: "draft",
    },
    publishedAt: {
      type: Date,
      default: null,
    },
    publishedBy: {
      type: String,
      default: "system",
    },
    snapshot: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    changelog: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model(
  "GamificationConfigVersion",
  GamificationConfigVersionSchema
);
