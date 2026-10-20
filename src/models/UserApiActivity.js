const mongoose = require("mongoose");
const { Schema } = mongoose;

const userApiActivitySchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    userEmail: {
      type: String,
      index: true,
    },
    username: {
      type: String,
      index: true,
    },
    actorType: {
      type: String,
      enum: ["user", "admin", "system", "anonymous"],
      default: "anonymous",
      required: true,
    },
    platform: {
      type: String,
      enum: ["web", "mobile", "unknown"],
      default: "unknown",
      required: true,
      index: true,
    },
    clientPlatformHint: {
      type: String,
      default: null,
    },
    transport: {
      type: String,
      enum: ["http", "socket"],
      default: "http",
      required: true,
      index: true,
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    method: {
      type: String,
      default: null,
    },
    route: {
      type: String,
      default: null,
    },
    statusCode: {
      type: Number,
      index: true,
    },
    outcome: {
      type: String,
      enum: ["success", "failure"],
      required: true,
      index: true,
    },
    durationMs: {
      type: Number,
      default: 0,
    },
    requestId: {
      type: String,
      required: true,
      index: true,
    },
    sessionIdHash: {
      type: String,
      default: null,
    },
    installationIdHash: {
      type: String,
      default: null,
    },
    appVersion: {
      type: String,
      default: null,
    },
    browser: {
      type: String,
      default: null,
    },
    os: {
      type: String,
      default: null,
    },
    deviceType: {
      type: String,
      default: null,
    },
    ipAddress: {
      type: String,
      default: null,
    },
    errorCode: {
      type: String,
      default: null,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 },
    },
  },
  {
    timestamps: { createdAt: false, updatedAt: false },
    versionKey: false,
  }
);

// Performance compound indexes for high-volume dashboard queries
userApiActivitySchema.index({ userId: 1, createdAt: -1 });
userApiActivitySchema.index({ platform: 1, createdAt: -1 });
userApiActivitySchema.index({ action: 1, createdAt: -1 });
userApiActivitySchema.index({ statusCode: 1, createdAt: -1 });
userApiActivitySchema.index({ outcome: 1, createdAt: -1 });
userApiActivitySchema.index({ requestId: 1 });
userApiActivitySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("UserApiActivity", userApiActivitySchema);
