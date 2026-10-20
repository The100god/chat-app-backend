const mongoose = require("mongoose");

const AdminAuditLogSchema = new mongoose.Schema({
  adminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Admin",
  },
  adminEmail: {
    type: String,
    default: "system",
  },
  action: {
    type: String,
    required: true,
  },
  category: {
    type: String,
    required: true,
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
  },
  ipAddress: {
    type: String,
  },
  userAgent: {
    type: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  expiresAt: {
    type: Date,
    required: true,
    default: () => new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
    index: { expires: 0 },
  },
});

AdminAuditLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("AdminAuditLog", AdminAuditLogSchema);
