const mongoose = require("mongoose");

const SystemConfigSchema = new mongoose.Schema({
  category: {
    type: String,
    required: true,
    index: true,
    enum: [
      "features",
      "themes",
      "animated_bg",
      "together_games",
      "couple_activities",
      "mobile_app",
      "chat_rules",
      "moderation",
      "general",
    ],
  },
  key: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  data: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
  },
  updatedBy: {
    type: String,
    default: "system",
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("SystemConfig", SystemConfigSchema);
