const express = require("express");
const router = express.Router();
const {
  adminLogin,
  getAdminMe,
  adminLogout,
  getDashboardStats,
  getAllConfigs,
  getConfigByCategory,
  updateConfigByCategory,
  resetConfigByCategory,
  getUsers,
  getUserById,
  updateUserStatus,
  updateUserProfileAdmin,
  resetUserPassword,
  deleteUser,
  getAuditLogs,
  changeSuperAdminPassword,
  getAdminsList,
  createAdmin,
  deleteAdmin,
  updateAdminRole,
  resetAdminPassword,
} = require("../controllers/adminController");
const {
  getActivityLogs,
  getActivityStats,
  exportActivityLogs,
  deleteActivityLog,
  bulkDeleteActivityLogs,
  getRetentionStats,
  verifyAndBackfillRetention,
} = require("../controllers/activityController");
const { adminProtect, requirePermission } = require("../middleware/adminAuth");

// Authentication
router.post("/auth/login", adminLogin);
router.get("/auth/me", adminProtect, getAdminMe);
router.post("/auth/logout", adminProtect, adminLogout);

// Analytics & Stats
router.get("/dashboard/stats", adminProtect, getDashboardStats);

// System Configuration CRUD
router.get("/config", adminProtect, getAllConfigs);
router.get("/config/:category", adminProtect, getConfigByCategory);
router.put("/config/:category", adminProtect, requirePermission("config.update"), updateConfigByCategory);
router.post("/config/:category/reset", adminProtect, requirePermission("config.update"), resetConfigByCategory);

// User Directory & Moderation
router.get("/users", adminProtect, requirePermission("users.view"), getUsers);
router.get("/users/:id", adminProtect, requirePermission("users.view"), getUserById);
router.put("/users/:id/status", adminProtect, requirePermission("users.moderate"), updateUserStatus);
router.put("/users/:id/profile", adminProtect, requirePermission("users.moderate"), updateUserProfileAdmin);
router.post("/users/:id/reset-password", adminProtect, requirePermission("users.moderate"), resetUserPassword);
router.delete("/users/:id", adminProtect, requirePermission("users.delete"), deleteUser);

// Audit Trail
router.get("/audit-logs", adminProtect, requirePermission("audit.view"), getAuditLogs);

// Monitoring: User API Activity (Web + Mobile) — Spec Section 71
router.get("/activity", adminProtect, requirePermission("activity.view"), getActivityLogs);
router.get("/activity/stats", adminProtect, requirePermission("activity.view"), getActivityStats);
router.get("/activity/export", adminProtect, requirePermission("activity.export"), exportActivityLogs);
router.delete("/activity/:id", adminProtect, requirePermission("activity.delete"), deleteActivityLog);
router.post("/activity/bulk-delete", adminProtect, requirePermission("activity.delete"), bulkDeleteActivityLogs);

// Monitoring: 15-Day Retention Policy & TTL Diagnostics — Spec Section 72
router.get("/retention/stats", adminProtect, requirePermission("activity.retention.view"), getRetentionStats);
router.post("/retention/verify", adminProtect, requirePermission("activity.retention.view"), verifyAndBackfillRetention);

// Super Admin Exclusive Privileges
router.put("/change-password", adminProtect, changeSuperAdminPassword);
router.get("/admins", adminProtect, getAdminsList);
router.post("/admins", adminProtect, createAdmin);
router.delete("/admins/:id", adminProtect, deleteAdmin);
router.put("/admins/:id/role", adminProtect, updateAdminRole);
router.post("/admins/:id/reset-password", adminProtect, resetAdminPassword);

module.exports = router;
