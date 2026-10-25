const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");

const adminProtect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.cookies && req.cookies.adminToken) {
    token = req.cookies.adminToken;
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "No admin authorization token provided",
      code: "NO_ADMIN_TOKEN",
    });
  }

  try {
    const secret = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || "default_admin_secret_key_123!";
    const decoded = jwt.verify(token, secret);

    const admin = await Admin.findById(decoded.id).select("-password");
    if (!admin) {
      return res.status(401).json({
        success: false,
        message: "Admin account not found",
        code: "ADMIN_NOT_FOUND",
      });
    }

    if (admin.status !== "active") {
      return res.status(403).json({
        success: false,
        message: `Admin account is ${admin.status}`,
        code: "ADMIN_STATUS_BLOCKED",
      });
    }

    req.admin = admin;
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      console.warn(`[AdminAuth] Token expired on ${req.method} ${req.originalUrl}`);
      return res.status(401).json({
        success: false,
        message: "Admin session token has expired",
        code: "TOKEN_EXPIRED",
      });
    }

    console.warn("Admin Auth Error:", error.message);
    return res.status(401).json({
      success: false,
      message: "Invalid admin authorization token",
      code: "INVALID_ADMIN_TOKEN",
    });
  }
};

const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.admin) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    if (
      req.admin.role === "super_admin" ||
      req.admin.permissions.includes("all") ||
      req.admin.permissions.includes(permission)
    ) {
      return next();
    }

    return res.status(403).json({
      success: false,
      message: `Forbidden: Missing required permission [${permission}]`,
    });
  };
};

module.exports = { adminProtect, requirePermission };
