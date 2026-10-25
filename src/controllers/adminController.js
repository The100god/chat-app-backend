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

// Helper to parse multiple admin emails from env
const getAdminEmails = () => {
  const envVal = process.env.ADMIN_EMAIL || process.env.ADMIN_EMAILS || "";
  return envVal
    .split(/[,\s;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
};

// Seed/sync default Super Admins based on ADMIN_EMAIL env list
const seedDefaultAdminIfNeeded = async () => {
  try {
    const adminEmails = getAdminEmails();
    if (adminEmails.length === 0) return;

    for (const email of adminEmails) {
      const user = await User.findOne({ email });
      const admin = await Admin.findOne({ email });

      if (user && !admin) {
        // Direct insert to retain existing user password hash
        await Admin.collection.insertOne({
          username: user.username,
          email: user.email.toLowerCase().trim(),
          password: user.password,
          role: "super_admin",
          permissions: ["all"],
          status: "active",
          failedLoginAttempts: 0,
          createdAt: new Date(),
        });
        console.log(`🛡️ Super Admin initialized from User account: ${email}`);
      } else if (admin && admin.role !== "super_admin") {
        admin.role = "super_admin";
        admin.status = "active";
        await admin.save();
      }
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

    const cleanIdentifier = identifier.toLowerCase().trim();
    const adminEmails = getAdminEmails();

    // 1. Look for matching account in User or Admin collection
    const user = await User.findOne({
      $or: [
        { email: cleanIdentifier },
        { username: { $regex: new RegExp(`^${identifier.trim().replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, "i") } },
      ],
    });

    let admin = await Admin.findOne({
      $or: [
        { email: cleanIdentifier },
        { username: { $regex: new RegExp(`^${identifier.trim().replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, "i") } },
      ],
    });

    const targetEmail = (user?.email || admin?.email || cleanIdentifier).toLowerCase().trim();

    // 2. Authorization check:
    // Email must be in ADMIN_EMAIL list, OR already configured as an active admin/super_admin in DB
    const isEnvAdmin = adminEmails.length > 0 ? adminEmails.includes(targetEmail) : false;
    const isDbAdmin = admin && ["super_admin", "admin"].includes(admin.role);

    if (!isEnvAdmin && !isDbAdmin) {
      return res.status(403).json({
        success: false,
        message: "Access denied: This email is not authorized as an administrator.",
      });
    }

    if (admin && admin.status !== "active") {
      return res.status(403).json({ success: false, message: `Account is ${admin.status}` });
    }

    // 3. Password Verification (check against user account, fallback to admin account)
    let isMatch = false;
    if (user) {
      isMatch = await user.matchPassword(password);
    }
    if (!isMatch && admin) {
      isMatch = await admin.matchPassword(password);
    }

    if (!isMatch) {
      if (admin) {
        admin.failedLoginAttempts = (admin.failedLoginAttempts || 0) + 1;
        await admin.save();
      }
      return res.status(401).json({ success: false, message: "Invalid admin credentials" });
    }

    // 4. Ensure an Admin document exists and is up to date
    if (!admin) {
      const username = user?.username || identifier.trim();
      const userHashedPassword = user?.password;

      if (userHashedPassword) {
        await Admin.collection.insertOne({
          username,
          email: targetEmail,
          password: userHashedPassword,
          role: "super_admin",
          permissions: ["all"],
          status: "active",
          failedLoginAttempts: 0,
          createdAt: new Date(),
        });
        admin = await Admin.findOne({ email: targetEmail });
      } else {
        admin = new Admin({
          username,
          email: targetEmail,
          password,
          role: "super_admin",
          permissions: ["all"],
          status: "active",
        });
        await admin.save();
      }
    } else {
      if (user && user.password && user.password !== admin.password) {
        await Admin.collection.updateOne(
          { _id: admin._id },
          { $set: { password: user.password } }
        );
      }
      admin.failedLoginAttempts = 0;
      admin.lastLogin = new Date();
      admin.status = "active";
      if (isEnvAdmin && admin.role !== "super_admin") {
        admin.role = "super_admin";
      }
      await admin.save();
    }

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
      details: { timestamp: new Date(), method: "credential" },
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
        { name: { $regex: search, $options: "i" } },
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

// ==========================================
// 8. User Moderation Actions (Spec v2)
// ==========================================
exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("-password");
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    let activityCount = 0;
    try {
      const UserApiActivity = require("../models/UserApiActivity");
      activityCount = await UserApiActivity.countDocuments({ user: user._id });
    } catch {}

    return res.json({
      success: true,
      user: {
        ...user.toObject(),
        activityCount,
        friendCount: user.friends ? user.friends.length : 0,
      },
    });
  } catch (error) {
    console.error("Get User By ID Error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch user details" });
  }
};

exports.updateUserStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isSuspended, suspendedReason, isVerified } = req.body;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const changes = {};
    if (typeof isSuspended === "boolean") {
      user.isSuspended = isSuspended;
      if (suspendedReason !== undefined) {
        user.suspendedReason = suspendedReason;
      }
      changes.isSuspended = isSuspended;
      changes.suspendedReason = suspendedReason;
    }

    if (typeof isVerified === "boolean") {
      user.isVerified = isVerified;
      changes.isVerified = isVerified;
    }

    await user.save();

    await AdminAuditLog.create({
      adminId: req.admin ? req.admin._id : null,
      adminEmail: req.admin ? req.admin.email : "admin",
      action: isSuspended ? "USER_SUSPENDED" : isSuspended === false ? "USER_UNSUSPENDED" : "USER_STATUS_UPDATED",
      category: "user_moderation",
      details: {
        targetUserId: user._id,
        targetUsername: user.username,
        targetEmail: user.email,
        changes,
      },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.json({
      success: true,
      message: `User '${user.username}' status updated successfully`,
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        isSuspended: user.isSuspended,
        suspendedReason: user.suspendedReason,
        isVerified: user.isVerified,
      },
    });
  } catch (error) {
    console.error("Update User Status Error:", error);
    return res.status(500).json({ success: false, message: "Failed to update user status" });
  }
};

exports.updateUserProfileAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { username, name, about } = req.body;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (username && username.toLowerCase().trim() !== user.username.toLowerCase().trim()) {
      return res.status(400).json({
        success: false,
        message: "Username is permanent and cannot be modified by any user or administrator.",
      });
    }

    const changes = {};
    if (name !== undefined) {
      const trimmedName = name.trim();
      if (!trimmedName) {
        return res.status(400).json({ success: false, message: "Display name cannot be empty." });
      }
      if (trimmedName.length > 50) {
        return res.status(400).json({ success: false, message: "Display name cannot exceed 50 characters." });
      }
      user.name = trimmedName;
      changes.name = trimmedName;
    }

    if (about !== undefined) {
      user.about = about;
      changes.about = about;
    }

    await user.save();

    await AdminAuditLog.create({
      adminId: req.admin ? req.admin._id : null,
      adminEmail: req.admin ? req.admin.email : "admin",
      action: "USER_PROFILE_UPDATED",
      category: "user_moderation",
      details: {
        targetUserId: user._id,
        targetUsername: user.username,
        targetEmail: user.email,
        changes,
      },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.json({
      success: true,
      message: `User '${user.username}' profile updated successfully`,
      user: {
        _id: user._id,
        username: user.username,
        name: user.name,
        email: user.email,
        about: user.about,
      },
    });
  } catch (error) {
    console.error("Update User Profile Admin Error:", error);
    return res.status(500).json({ success: false, message: "Failed to update user profile" });
  }
};

exports.resetUserPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters long" });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    user.password = newPassword;
    await user.save(); // pre-save will bcrypt hash it

    await AdminAuditLog.create({
      adminId: req.admin ? req.admin._id : null,
      adminEmail: req.admin ? req.admin.email : "admin",
      action: "USER_PASSWORD_RESET",
      category: "user_moderation",
      details: {
        targetUserId: user._id,
        targetUsername: user.username,
        targetEmail: user.email,
      },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.json({
      success: true,
      message: `Password for user '${user.username}' has been successfully reset.`,
    });
  } catch (error) {
    console.error("Reset User Password Error:", error);
    return res.status(500).json({ success: false, message: "Failed to reset user password" });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    await User.findByIdAndDelete(id);

    await AdminAuditLog.create({
      adminId: req.admin ? req.admin._id : null,
      adminEmail: req.admin ? req.admin.email : "admin",
      action: "USER_ACCOUNT_DELETED",
      category: "user_moderation",
      details: {
        deletedUserId: id,
        deletedUsername: user.username,
        deletedEmail: user.email,
      },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.json({
      success: true,
      message: `User account '${user.username}' permanently deleted.`,
    });
  } catch (error) {
    console.error("Delete User Error:", error);
    return res.status(500).json({ success: false, message: "Failed to delete user account" });
  }
};

exports.updateAdminRole = async (req, res) => {
  try {
    if (req.admin.role !== "super_admin") {
      return res.status(403).json({ success: false, message: "Forbidden: Super Admin only" });
    }
    const { id } = req.params;
    const { role } = req.body;
    if (!role || !["super_admin", "admin", "moderator"].includes(role)) {
      return res.status(400).json({ success: false, message: "Invalid role specified" });
    }

    const targetAdmin = await Admin.findById(id);
    if (!targetAdmin) {
      return res.status(404).json({ success: false, message: "Admin account not found" });
    }

    const oldRole = targetAdmin.role;
    targetAdmin.role = role;
    await targetAdmin.save();

    await AdminAuditLog.create({
      adminId: req.admin._id,
      adminEmail: req.admin.email,
      action: "UPDATE_ADMIN_ROLE",
      category: "admin_management",
      details: { adminId: id, adminEmail: targetAdmin.email, oldRole, newRole: role },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.json({
      success: true,
      message: `Role for '${targetAdmin.username}' updated to ${role}.`,
      admin: {
        id: targetAdmin._id,
        username: targetAdmin.username,
        email: targetAdmin.email,
        role: targetAdmin.role,
      },
    });
  } catch (error) {
    console.error("Update Admin Role Error:", error);
    return res.status(500).json({ success: false, message: "Failed to update admin role" });
  }
};

exports.resetAdminPassword = async (req, res) => {
  try {
    if (req.admin.role !== "super_admin") {
      return res.status(403).json({ success: false, message: "Forbidden: Super Admin only" });
    }
    const { id } = req.params;
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: "New password must be at least 6 characters" });
    }

    const targetAdmin = await Admin.findById(id);
    if (!targetAdmin) {
      return res.status(404).json({ success: false, message: "Admin account not found" });
    }

    targetAdmin.password = newPassword;
    await targetAdmin.save();

    await AdminAuditLog.create({
      adminId: req.admin._id,
      adminEmail: req.admin.email,
      action: "RESET_ADMIN_PASSWORD",
      category: "admin_management",
      details: { adminId: id, adminEmail: targetAdmin.email },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.json({
      success: true,
      message: `Password for admin '${targetAdmin.username}' successfully reset.`,
    });
  } catch (error) {
    console.error("Reset Admin Password Error:", error);
    return res.status(500).json({ success: false, message: "Failed to reset admin password" });
  }
};
