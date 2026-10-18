const Admin = require("../models/Admin");
const SystemConfig = require("../models/SystemConfig");
const AdminAuditLog = require("../models/AdminAuditLog");
const User = require("../models/User");
const Message = require("../models/Message");
const Group = require("../models/Group");
const defaultConfigs = require("../config/defaultAdminConfigs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

// In-memory config cache for ultra-fast public endpoint response
let cachedPublicConfig = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute

const generateAdminToken = (admin) => {
  const secret = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || "default_admin_secret_key_123!";
  return jwt.sign(
    {
      id: admin._id,
      email: admin.email,
      username: admin.username,
      role: admin.role,
      permissions: admin.permissions,
    },
    secret,
    { expiresIn: "7d" }
  );
};

// Seed default Super Admin if none exists
const seedDefaultAdminIfNeeded = async () => {
  try {
    const adminEmail = (process.env.ADMIN_EMAIL || "admin@chugli.app").toLowerCase().trim();
    const adminPassword = process.env.ADMIN_PASSWORD || "Admin@Password123!";

    const adminCount = await Admin.countDocuments();
    if (adminCount === 0) {
      const defaultAdmin = new Admin({
        username: "superadmin",
        email: adminEmail,
        password: adminPassword,
        role: "super_admin",
        permissions: ["all"],
        status: "active",
      });
      await defaultAdmin.save();
      console.log(`🛡️ Default Super Admin initialized: ${adminEmail} / ${adminPassword}`);
    }
  } catch (err) {
    console.error("Error seeding default admin:", err.message);
  }
};

// Initialize default configs in DB if absent
const getConfigFromDbOrSeed = async (category) => {
  let doc = await SystemConfig.findOne({ category });
  if (!doc && defaultConfigs[category]) {
    doc = await SystemConfig.create({
      category,
      key: `config_${category}`,
      data: defaultConfigs[category],
      updatedBy: "system",
      updatedAt: new Date(),
    });
  }
  return doc ? doc.data : defaultConfigs[category] || null;
};

// ==========================================
// 1. Admin Auth
// ==========================================
exports.adminLogin = async (req, res) => {
  try {
    await seedDefaultAdminIfNeeded();

    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: "Please provide username/email and password" });
    }

    const admin = await Admin.findOne({
      $or: [
        { email: identifier.toLowerCase().trim() },
        { username: identifier.trim() },
      ],
    });

    if (!admin) {
      return res.status(401).json({ success: false, message: "Invalid admin credentials" });
    }

    if (admin.status !== "active") {
      return res.status(403).json({ success: false, message: `Account is ${admin.status}` });
    }

    const isMatch = await admin.matchPassword(password);
    if (!isMatch) {
      admin.failedLoginAttempts = (admin.failedLoginAttempts || 0) + 1;
      await admin.save();
      return res.status(401).json({ success: false, message: "Invalid admin credentials" });
    }

    admin.failedLoginAttempts = 0;
    admin.lastLogin = new Date();
    await admin.save();

    const token = generateAdminToken(admin);

    res.cookie("adminToken", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    // Log admin login action
    await AdminAuditLog.create({
      adminId: admin._id,
      adminEmail: admin.email,
      action: "ADMIN_LOGIN",
      category: "auth",
      details: { timestamp: new Date() },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.json({
      success: true,
      token,
      admin: {
        id: admin._id,
        username: admin.username,
        email: admin.email,
        role: admin.role,
        permissions: admin.permissions,
        lastLogin: admin.lastLogin,
      },
    });
  } catch (error) {
    console.error("Admin Login Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

exports.getAdminMe = async (req, res) => {
  return res.json({
    success: true,
    admin: req.admin,
  });
};

exports.adminLogout = async (req, res) => {
  res.clearCookie("adminToken");
  return res.json({ success: true, message: "Admin logged out successfully" });
};

// ==========================================
// 2. Dashboard Analytics & Stats
// ==========================================
exports.getDashboardStats = async (req, res) => {
  try {
    const [totalUsers, totalMessages, totalGroups] = await Promise.all([
      User.countDocuments().catch(() => 0),
      Message.countDocuments().catch(() => 0),
      Group.countDocuments().catch(() => 0),
    ]);

    const activeSockets = req.io ? req.io.engine.clientsCount : 0;
    const uptime = process.uptime();
    const memory = process.memoryUsage();

    return res.json({
      success: true,
      stats: {
        totalUsers,
        totalMessages,
        totalGroups,
        activeSockets,
        serverUptimeSeconds: Math.floor(uptime),
        memoryUsageMB: Math.round(memory.rss / (1024 * 1024)),
        dbConnected: mongoose.connection.readyState === 1,
      },
    });
  } catch (error) {
    console.error("Get Stats Error:", error);
    return res.status(500).json({ success: false, message: "Failed to load dashboard stats" });
  }
};

// ==========================================
// 3. Configuration Management (Dynamic Control)
// ==========================================
exports.getAllConfigs = async (req, res) => {
  try {
    const categories = [
      "features",
      "themes",
      "animated_bg",
      "together_games",
      "couple_activities",
      "mobile_app",
    ];

    const result = {};
    for (const cat of categories) {
      result[cat] = await getConfigFromDbOrSeed(cat);
    }

    return res.json({ success: true, configs: result });
  } catch (error) {
    console.error("Get All Configs Error:", error);
    return res.status(500).json({ success: false, message: "Failed to load configurations" });
  }
};

exports.getConfigByCategory = async (req, res) => {
  try {
    const { category } = req.params;
    const data = await getConfigFromDbOrSeed(category);
    if (!data) {
      return res.status(404).json({ success: false, message: `Configuration category '${category}' not found` });
    }
    return res.json({ success: true, category, data });
  } catch (error) {
    console.error("Get Config By Category Error:", error);
    return res.status(500).json({ success: false, message: "Failed to load category configuration" });
  }
};

exports.updateConfigByCategory = async (req, res) => {
  try {
    const { category } = req.params;
    const { data } = req.body;

    if (!data) {
      return res.status(400).json({ success: false, message: "Config data payload is required" });
    }

    const updatedDoc = await SystemConfig.findOneAndUpdate(
      { category },
      {
        data,
        updatedBy: req.admin ? req.admin.email : "admin",
        updatedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    // Invalidate public cached config
    cachedPublicConfig = null;

    // Log the change in Audit Log
    await AdminAuditLog.create({
      adminId: req.admin ? req.admin._id : null,
      adminEmail: req.admin ? req.admin.email : "admin",
      action: `UPDATE_CONFIG_${category.toUpperCase()}`,
      category,
      details: { summary: `Updated ${category} configuration`, keysUpdated: Object.keys(data) },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    // Realtime broadcast to connected Web & Mobile clients
    if (req.io) {
      req.io.emit("admin:config_updated", {
        category,
        data: updatedDoc.data,
        updatedAt: updatedDoc.updatedAt,
      });

      // Targeted socket events for fast client handlers
      if (category === "themes") {
        req.io.emit("theme:updated", updatedDoc.data);
      } else if (category === "features") {
        req.io.emit("features:updated", updatedDoc.data);
      } else if (category === "animated_bg") {
        req.io.emit("animated_bg:updated", updatedDoc.data);
      } else if (category === "mobile_app") {
        req.io.emit("mobile_app:updated", updatedDoc.data);
      } else if (category === "together_games") {
        req.io.emit("together_games:updated", updatedDoc.data);
      } else if (category === "couple_activities") {
        req.io.emit("couple_activities:updated", updatedDoc.data);
      }
    }

    return res.json({
      success: true,
      message: `Configuration for '${category}' updated successfully`,
      data: updatedDoc.data,
      updatedAt: updatedDoc.updatedAt,
    });
  } catch (error) {
    console.error("Update Config Error:", error);
    return res.status(500).json({ success: false, message: "Failed to update configuration" });
  }
};

exports.resetConfigByCategory = async (req, res) => {
  try {
    const { category } = req.params;
    const { themeId } = req.body || {};
    const defaultData = defaultConfigs[category];

    if (!defaultData) {
      return res.status(404).json({
        success: false,
        message: `No default preset found for category '${category}'`,
      });
    }

    let newDataToSave = defaultData;

    // If category is themes and a specific themeId is provided, reset only that theme
    if (category === "themes" && themeId && defaultData.themes && defaultData.themes[themeId]) {
      const existingDoc = await SystemConfig.findOne({ category });
      const currentConfig = existingDoc ? existingDoc.data : defaultData;
      newDataToSave = {
        ...currentConfig,
        themes: {
          ...(currentConfig.themes || {}),
          [themeId]: defaultData.themes[themeId],
        },
      };
    }

    const updatedDoc = await SystemConfig.findOneAndUpdate(
      { category },
      {
        data: newDataToSave,
        updatedBy: req.admin ? req.admin.email : "admin",
        updatedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    // Invalidate public cached config
    cachedPublicConfig = null;

    // Log the change in Audit Log
    await AdminAuditLog.create({
      adminId: req.admin ? req.admin._id : null,
      adminEmail: req.admin ? req.admin.email : "admin",
      action: `RESET_CONFIG_${category.toUpperCase()}`,
      category,
      details: {
        summary: themeId
          ? `Reset ${category}.${themeId} to original default preset`
          : `Reset ${category} to original default presets`,
        themeId: themeId || null,
      },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    // Realtime broadcast to connected Web & Mobile clients
    if (req.io) {
      req.io.emit("admin:config_updated", {
        category,
        data: updatedDoc.data,
        updatedAt: updatedDoc.updatedAt,
      });

      if (category === "themes") {
        req.io.emit("theme:updated", updatedDoc.data);
      } else if (category === "features") {
        req.io.emit("features:updated", updatedDoc.data);
      } else if (category === "animated_bg") {
        req.io.emit("animated_bg:updated", updatedDoc.data);
      }
    }

    return res.json({
      success: true,
      message: themeId
        ? `Theme '${themeId}' successfully reset to original colors`
        : `Configuration for '${category}' successfully reset to original presets`,
      data: updatedDoc.data,
      updatedAt: updatedDoc.updatedAt,
    });
  } catch (error) {
    console.error("Reset Config Error:", error);
    return res.status(500).json({ success: false, message: "Failed to reset configuration" });
  }
};

// ==========================================
// 4. Public Endpoint for Clients (Web & Mobile)
// ==========================================
exports.getPublicConfig = async (req, res) => {
  try {
    const now = Date.now();
    if (cachedPublicConfig && now - lastCacheTime < CACHE_TTL_MS) {
      return res.json(cachedPublicConfig);
    }

    const categories = ["features", "themes", "animated_bg", "together_games", "couple_activities", "mobile_app"];
    const payload = {};
    for (const cat of categories) {
      payload[cat] = await getConfigFromDbOrSeed(cat);
    }

    const responseData = {
      success: true,
      timestamp: new Date().toISOString(),
      config: payload,
    };

    cachedPublicConfig = responseData;
    lastCacheTime = now;

    return res.json(responseData);
  } catch (error) {
    console.error("Get Public Config Error:", error);
    // Fall back to default static config
    return res.json({
      success: true,
      timestamp: new Date().toISOString(),
      config: defaultConfigs,
      fallback: true,
    });
  }
};

// ==========================================
// 5. User Directory & Moderation
// ==========================================
exports.getUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || "";

    const query = {};
    if (search) {
      query.$or = [
        { username: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(query)
        .select("-password")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      User.countDocuments(query),
    ]);

    return res.json({
      success: true,
      users,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Get Users Error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch users" });
  }
};

// ==========================================
// 6. Audit Trail Logs
// ==========================================
exports.getAuditLogs = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const logs = await AdminAuditLog.find()
      .sort({ createdAt: -1 })
      .limit(limit);

    return res.json({ success: true, logs });
  } catch (error) {
    console.error("Get Audit Logs Error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch audit logs" });
  }
};

// ==========================================
// 7. Super Admin Privileged Management
// ==========================================
exports.changeSuperAdminPassword = async (req, res) => {
  try {
    if (req.admin.role !== "super_admin") {
      return res.status(403).json({
        success: false,
        message: "Forbidden: Only Super Admin can change Super Admin password",
      });
    }

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 6 characters long",
      });
    }

    const admin = await Admin.findById(req.admin._id);
    if (!admin) {
      return res.status(404).json({ success: false, message: "Admin account not found" });
    }

    const isMatch = await admin.matchPassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Current password does not match",
      });
    }

    admin.password = newPassword;
    await admin.save();

    await AdminAuditLog.create({
      adminId: admin._id,
      adminEmail: admin.email,
      action: "SUPER_ADMIN_PASSWORD_CHANGED",
      category: "security",
      details: { summary: "Super Admin updated their password" },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.json({
      success: true,
      message: "Super Admin password updated successfully",
    });
  } catch (error) {
    console.error("Change Password Error:", error);
    return res.status(500).json({ success: false, message: "Failed to change password" });
  }
};

exports.getAdminsList = async (req, res) => {
  try {
    if (req.admin.role !== "super_admin") {
      return res.status(403).json({
        success: false,
        message: "Forbidden: Only Super Admin can view admin accounts list",
      });
    }

    const admins = await Admin.find().select("-password").sort({ createdAt: -1 });
    return res.json({ success: true, admins });
  } catch (error) {
    console.error("Get Admins List Error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch admins" });
  }
};

exports.createAdmin = async (req, res) => {
  try {
    if (req.admin.role !== "super_admin") {
      return res.status(403).json({
        success: false,
        message: "Forbidden: Only Super Admin can create new admin accounts",
      });
    }

    const { username, email, password, role, permissions } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Username, email, and password are required",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters long",
      });
    }

    const existingAdmin = await Admin.findOne({
      $or: [{ email: email.toLowerCase().trim() }, { username: username.trim() }],
    });

    if (existingAdmin) {
      return res.status(400).json({
        success: false,
        message: "An admin with this email or username already exists",
      });
    }

    const newAdmin = new Admin({
      username: username.trim(),
      email: email.toLowerCase().trim(),
      password,
      role: role || "admin",
      permissions: Array.isArray(permissions) && permissions.length > 0 ? permissions : ["all"],
      status: "active",
    });

    await newAdmin.save();

    await AdminAuditLog.create({
      adminId: req.admin._id,
      adminEmail: req.admin.email,
      action: "CREATE_ADMIN_ACCOUNT",
      category: "admin_management",
      details: {
        createdAdminEmail: newAdmin.email,
        createdAdminRole: newAdmin.role,
        permissions: newAdmin.permissions,
      },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.status(201).json({
      success: true,
      message: "Admin account created successfully",
      admin: {
        id: newAdmin._id,
        username: newAdmin.username,
        email: newAdmin.email,
        role: newAdmin.role,
        permissions: newAdmin.permissions,
        status: newAdmin.status,
      },
    });
  } catch (error) {
    console.error("Create Admin Error:", error);
    return res.status(500).json({ success: false, message: "Failed to create admin" });
  }
};

exports.deleteAdmin = async (req, res) => {
  try {
    if (req.admin.role !== "super_admin") {
      return res.status(403).json({
        success: false,
        message: "Forbidden: Only Super Admin can delete admin accounts",
      });
    }

    const { id } = req.params;
    if (id === req.admin._id.toString()) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete your own active Super Admin account",
      });
    }

    const targetAdmin = await Admin.findById(id);
    if (!targetAdmin) {
      return res.status(404).json({ success: false, message: "Admin not found" });
    }

    if (targetAdmin.role === "super_admin") {
      return res.status(400).json({
        success: false,
        message: "Cannot delete another Super Admin account",
      });
    }

    await Admin.findByIdAndDelete(id);

    await AdminAuditLog.create({
      adminId: req.admin._id,
      adminEmail: req.admin.email,
      action: "DELETE_ADMIN_ACCOUNT",
      category: "admin_management",
      details: { deletedEmail: targetAdmin.email, deletedUsername: targetAdmin.username },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.json({
      success: true,
      message: `Admin account '${targetAdmin.username}' deleted successfully`,
    });
  } catch (error) {
    console.error("Delete Admin Error:", error);
    return res.status(500).json({ success: false, message: "Failed to delete admin" });
  }
};
