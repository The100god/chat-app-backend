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
  getAuditLogs,
  changeSuperAdminPassword,
  getAdminsList,
  createAdmin,
  deleteAdmin,
} = require("../controllers/adminController");
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

// User Directory
router.get("/users", adminProtect, requirePermission("users.view"), getUsers);

// Audit Trail
router.get("/audit-logs", adminProtect, requirePermission("audit.view"), getAuditLogs);

// Super Admin Exclusive Privileges
router.put("/change-password", adminProtect, changeSuperAdminPassword);
router.get("/admins", adminProtect, getAdminsList);
router.post("/admins", adminProtect, createAdmin);
router.delete("/admins/:id", adminProtect, deleteAdmin);

module.exports = router;
