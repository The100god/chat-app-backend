const crypto = require("crypto");
const UserApiActivity = require("../models/UserApiActivity");

// 15 days in milliseconds
const RETENTION_MS = 15 * 24 * 60 * 60 * 1000;

// High-noise URL patterns to exclude from activity logging (to prevent database bloat)
const IGNORED_PATHS = [
  /^\/api\/health/i,
  /^\/uploads/i,
  /^\/favicon\.ico/i,
  /^\/api\/admin\/dashboard\/stats/i, // exclude rapid admin polling
  /^\/api\/admin\/activity/i, // exclude recursive logging of activity queries
];

/**
 * Determine client platform: 'web' | 'mobile' | 'unknown'
 */
const parsePlatform = (req) => {
  const customHeader = (req.headers["x-client-platform"] || req.headers["client-platform"] || "").toLowerCase();
  if (customHeader === "mobile") return "mobile";
  if (customHeader === "web") return "web";

  const ua = (req.headers["user-agent"] || "").toLowerCase();
  if (!ua) return "unknown";

  if (
    ua.includes("okhttp") ||
    ua.includes("expo") ||
    ua.includes("cfnetwork") ||
    ua.includes("dalvik") ||
    ua.includes("reactnative") ||
    ua.includes("android") ||
    ua.includes("iphone") ||
    ua.includes("ipad") ||
    ua.includes("mobile")
  ) {
    return "mobile";
  }

  if (
    ua.includes("mozilla") ||
    ua.includes("chrome") ||
    ua.includes("safari") ||
    ua.includes("firefox") ||
    ua.includes("edge") ||
    ua.includes("webkit")
  ) {
    return "web";
  }

  return "unknown";
};

/**
 * Parse browser, OS, and device type from User-Agent safely
 */
const parseDeviceDetails = (req) => {
  const ua = req.headers["user-agent"] || "";
  let browser = "Other";
  let os = "Other";
  let deviceType = "Desktop";

  if (/Mobile|Android|iPhone|iPad|iPod/i.test(ua)) {
    deviceType = /iPad|Tablet/i.test(ua) ? "Tablet" : "Mobile";
  }

  // OS detection
  if (/Windows NT/i.test(ua)) os = "Windows";
  else if (/Android/i.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
  else if (/Macintosh|Mac OS X/i.test(ua)) os = "macOS";
  else if (/Linux/i.test(ua)) os = "Linux";

  // Browser detection
  if (/Expo/i.test(ua)) browser = "Expo App";
  else if (/okhttp/i.test(ua)) browser = "Mobile HTTP Client";
  else if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) browser = "Chrome";
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = "Safari";
  else if (/Firefox\//i.test(ua)) browser = "Firefox";

  return { browser, os, deviceType };
};

/**
 * Sanitize metadata: strictly allowlist safe operational identifiers and values.
 * Never log message bodies, passwords, tokens, auth headers, pins, or sensitive content.
 */
const sanitizeMetadata = (raw) => {
  if (!raw || typeof raw !== "object") return {};

  const SAFE_KEYS = [
    "chatId",
    "friendId",
    "targetUserId",
    "recipientId",
    "groupId",
    "roomId",
    "gameType",
    "category",
    "actionType",
    "messageType",
    "fileType",
    "fileSize",
    "queryTerm",
    "page",
    "limit",
    "status",
    "step",
    "round",
    "score",
  ];

  const sanitized = {};
  for (const key of Object.keys(raw)) {
    if (SAFE_KEYS.includes(key)) {
      sanitized[key] = raw[key];
    }
  }
  return sanitized;
};

/**
 * Normalize route into clean parameterized pattern
 */
const normalizeRoute = (req) => {
  let routePath = req.baseUrl ? `${req.baseUrl}${req.path || ""}` : req.path || req.originalUrl || "/";
  // Strip query strings
  routePath = routePath.split("?")[0];
  // Normalize 24-character hex MongoDB ObjectIds to :id
  routePath = routePath.replace(/\/[0-9a-fA-F]{24}/g, "/:id");
  // Normalize numeric parameters to :id
  routePath = routePath.replace(/\/\d+/g, "/:id");
  return routePath;
};

/**
 * Map route & method to explicit business action name
 */
const determineActionName = (req, route) => {
  const method = (req.method || "GET").toUpperCase();

  // Auth routes
  if (route.startsWith("/api/auth/login")) return "auth.login";
  if (route.startsWith("/api/auth/register")) return "auth.register";
  if (route.startsWith("/api/auth/logout")) return "auth.logout";
  if (route.startsWith("/api/auth/google")) return "auth.google_login";
  if (route.startsWith("/api/auth/refresh")) return "auth.refresh_token";
  if (route.startsWith("/api/auth/change-password")) return "auth.change_password";

  // Friend routes
  if (route.includes("/friends/send-request")) return "friend.request_send";
  if (route.includes("/friends/accept-request")) return "friend.request_accept";
  if (route.includes("/friends/reject-request")) return "friend.request_reject";
  if (route.includes("/friends/remove")) return "friend.remove";
  if (route.startsWith("/api/friends")) return "friend.list_view";

  // Messages & Chat
  if (route.startsWith("/api/message") && method === "POST") return "message.send";
  if (route.startsWith("/api/message") && method === "GET") return "message.fetch";
  if (route.startsWith("/api/message/:id") && method === "DELETE") return "message.delete";
  if (route.startsWith("/api/chat")) return "chat.access";

  // Groups
  if (route.startsWith("/api/groups") && method === "POST") return "group.create";
  if (route.startsWith("/api/groups/:id") && method === "PUT") return "group.update";
  if (route.startsWith("/api/groups/:id/members") && method === "POST") return "group.member_add";
  if (route.startsWith("/api/groups")) return "group.view";

  // Users & Profiles
  if (route.startsWith("/api/users/profile")) return "user.profile_view";
  if (route.startsWith("/api/users/update") || (route.startsWith("/api/users") && method === "PUT")) return "user.profile_update";
  if (route.startsWith("/api/users") && method === "GET") return "user.search";

  // Media
  if (route.startsWith("/api/upload-url")) return "media.upload_url";
  if (route.startsWith("/api/upload")) return "media.upload";

  // Config & Admin
  if (route.startsWith("/api/config/public")) return "config.fetch_public";
  if (route.startsWith("/api/admin")) return `admin.${route.replace(/^\/api\/admin\/?/, "").replace(/\//g, "_") || "access"}`;

  // Fallback explicit name
  const clean = route.replace(/^\/api\//, "").replace(/[\/:_]+/g, "_");
  return `${method.toLowerCase()}.${clean || "root"}`;
};

/**
 * Record an HTTP API Activity log entry asynchronously
 */
const recordHttpActivity = async ({ req, res, durationMs }) => {
  try {
    const rawUrl = req.originalUrl || req.url || "";
    // Check if path is in ignored list
    if (IGNORED_PATHS.some((regex) => regex.test(rawUrl))) {
      return;
    }

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + RETENTION_MS);

    const platform = parsePlatform(req);
    const { browser, os, deviceType } = parseDeviceDetails(req);
    const route = normalizeRoute(req);
    const action = determineActionName(req, route);
    const statusCode = res.statusCode || 200;
    const outcome = statusCode >= 400 ? "failure" : "success";

    // Extract user identity from verified req.user or req.admin
    let userId = null;
    let username = null;
    let userEmail = null;
    let actorType = "anonymous";

    if (req.user) {
      actorType = "user";
      userId = req.user._id || req.user.id;
      username = req.user.username;
      userEmail = req.user.email;
    } else if (req.admin) {
      actorType = "admin";
      userId = req.admin._id || req.admin.id;
      username = req.admin.username;
      userEmail = req.admin.email;
    }

    const clientPlatformHint = req.headers["x-client-platform"] || req.headers["client-platform"] || null;
    const appVersion = req.headers["x-app-version"] || req.headers["app-version"] || null;
    const installationId = req.headers["x-installation-id"] || null;
    const installationIdHash = installationId
      ? crypto.createHash("sha256").update(installationId).digest("hex").slice(0, 16)
      : null;

    const ipAddress = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();

    // Prepare safe metadata
    const safeMetadata = {
      ...sanitizeMetadata(req.query),
      ...sanitizeMetadata(req.body),
    };

    let errorCode = null;
    if (statusCode >= 400) {
      errorCode = res.locals?.errorCode || (statusCode === 401 ? "UNAUTHORIZED" : statusCode === 403 ? "FORBIDDEN" : statusCode === 404 ? "NOT_FOUND" : statusCode === 429 ? "RATE_LIMITED" : "SERVER_ERROR");
    }

    await UserApiActivity.create({
      userId,
      username,
      userEmail,
      actorType,
      platform,
      clientPlatformHint,
      transport: "http",
      action,
      method: req.method,
      route,
      statusCode,
      outcome,
      durationMs,
      requestId: req.requestId || crypto.randomUUID(),
      installationIdHash,
      appVersion,
      browser,
      os,
      deviceType,
      ipAddress,
      errorCode,
      metadata: safeMetadata,
      createdAt,
      expiresAt,
    });
  } catch (err) {
    // Non-blocking: fail quietly without impacting client request
    console.error("⚠️ Activity Logging error (non-fatal):", err.message);
  }
};

/**
 * Record a Realtime / Socket.io Activity log entry asynchronously
 */
const recordSocketActivity = async ({
  socket,
  action,
  outcome = "success",
  metadata = {},
  durationMs = 0,
  errorCode = null,
}) => {
  try {
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + RETENTION_MS);

    // Platform detection for socket handshake
    let platform = "unknown";
    const handshakeHeaders = socket.handshake?.headers || {};
    const customHeader = (handshakeHeaders["x-client-platform"] || socket.handshake?.auth?.platform || "").toLowerCase();

    if (customHeader === "mobile") platform = "mobile";
    else if (customHeader === "web") platform = "web";
    else {
      const ua = (handshakeHeaders["user-agent"] || "").toLowerCase();
      if (ua.includes("okhttp") || ua.includes("expo") || ua.includes("mobile") || ua.includes("android") || ua.includes("iphone")) {
        platform = "mobile";
      } else if (ua.includes("mozilla") || ua.includes("chrome") || ua.includes("safari")) {
        platform = "web";
      }
    }

    const userId = socket.userId || socket.handshake?.auth?.userId || null;
    const ipAddress = (handshakeHeaders["x-forwarded-for"] || socket.handshake?.address || "").split(",")[0].trim();

    await UserApiActivity.create({
      userId: userId && /^[0-9a-fA-F]{24}$/.test(String(userId)) ? userId : null,
      actorType: userId ? "user" : "anonymous",
      platform,
      transport: "socket",
      action,
      method: "SOCKET",
      route: `socket://${action}`,
      statusCode: outcome === "success" ? 200 : 400,
      outcome,
      durationMs,
      requestId: crypto.randomUUID(),
      ipAddress,
      errorCode,
      metadata: sanitizeMetadata(metadata),
      createdAt,
      expiresAt,
    });
  } catch (err) {
    console.error("⚠️ Socket Activity Logging error (non-fatal):", err.message);
  }
};

module.exports = {
  RETENTION_MS,
  recordHttpActivity,
  recordSocketActivity,
};
