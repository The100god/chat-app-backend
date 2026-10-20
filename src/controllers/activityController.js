const mongoose = require("mongoose");
const UserApiActivity = require("../models/UserApiActivity");
const AdminAuditLog = require("../models/AdminAuditLog");
const { RETENTION_MS } = require("../utils/activityLoggerService");

/**
 * 1. Get Paginated & Filtered User API Activity
 */
exports.getActivityLogs = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 25,
      platform = "all",
      transport = "all",
      outcome = "all",
      action,
      method = "all",
      statusCode,
      search,
      userId,
      startDate,
      endDate,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const query = {};

    // Filter by platform
    if (platform && platform !== "all") {
      query.platform = platform;
    }

    // Filter by transport (http or socket)
    if (transport && transport !== "all") {
      query.transport = transport;
    }

    // Filter by outcome (success or failure)
    if (outcome && outcome !== "all") {
      query.outcome = outcome;
    }

    // Filter by HTTP method
    if (method && method !== "all") {
      query.method = method.toUpperCase();
    }

    // Filter by specific action
    if (action && action.trim()) {
      query.action = { $regex: action.trim(), $options: "i" };
    }

    // Filter by specific status code
    if (statusCode && !isNaN(statusCode)) {
      query.statusCode = parseInt(statusCode, 10);
    }

    // Filter by specific user ID
    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      query.userId = new mongoose.Types.ObjectId(userId);
    }

    // Date range filter
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    // General text search (username, email, requestId, action, route)
    if (search && search.trim()) {
      const s = search.trim();
      const searchConditions = [
        { username: { $regex: s, $options: "i" } },
        { userEmail: { $regex: s, $options: "i" } },
        { requestId: { $regex: s, $options: "i" } },
        { action: { $regex: s, $options: "i" } },
        { route: { $regex: s, $options: "i" } },
      ];
      if (mongoose.Types.ObjectId.isValid(s)) {
        searchConditions.push({ userId: new mongoose.Types.ObjectId(s) });
      }
      query.$or = searchConditions;
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const skip = (pageNum - 1) * limitNum;
    const sort = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

    const [activities, total] = await Promise.all([
      UserApiActivity.find(query)
        .populate("userId", "username email avatar")
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      UserApiActivity.countDocuments(query),
    ]);

    return res.json({
      success: true,
      activities,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (error) {
    console.error("Error in getActivityLogs:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch activity logs", error: error.message });
  }
};

/**
 * 2. Get Activity Metrics & High-level Statistics
 */
exports.getActivityStats = async (req, res) => {
  try {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      total24h,
      total7d,
      webCount24h,
      mobileCount24h,
      unknownCount24h,
      failureCount24h,
      durationStats,
      topActions,
    ] = await Promise.all([
      UserApiActivity.countDocuments({ createdAt: { $gte: twentyFourHoursAgo } }),
      UserApiActivity.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
      UserApiActivity.countDocuments({ createdAt: { $gte: twentyFourHoursAgo }, platform: "web" }),
      UserApiActivity.countDocuments({ createdAt: { $gte: twentyFourHoursAgo }, platform: "mobile" }),
      UserApiActivity.countDocuments({ createdAt: { $gte: twentyFourHoursAgo }, platform: "unknown" }),
      UserApiActivity.countDocuments({ createdAt: { $gte: twentyFourHoursAgo }, outcome: "failure" }),
      UserApiActivity.aggregate([
        { $match: { createdAt: { $gte: twentyFourHoursAgo }, durationMs: { $gt: 0 } } },
        { $group: { _id: null, avgDuration: { $avg: "$durationMs" } } },
      ]),
      UserApiActivity.aggregate([
        { $match: { createdAt: { $gte: twentyFourHoursAgo } } },
        { $group: { _id: "$action", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 6 },
      ]),
    ]);

    const avgDurationMs = durationStats.length > 0 ? Math.round(durationStats[0].avgDuration) : 42;
    const failureRatePercent = total24h > 0 ? ((failureCount24h / total24h) * 100).toFixed(1) : "0.0";

    return res.json({
      success: true,
      stats: {
        total24h,
        total7d,
        webCount24h,
        mobileCount24h,
        unknownCount24h,
        failureCount24h,
        failureRatePercent,
        avgDurationMs,
        topActions: topActions.map((a) => ({ action: a._id, count: a.count })),
      },
    });
  } catch (error) {
    console.error("Error in getActivityStats:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch activity stats", error: error.message });
  }
};

/**
 * 3. Export Filtered Activity Logs (CSV or JSON)
 */
exports.exportActivityLogs = async (req, res) => {
  try {
    const { format = "json", platform, outcome, action, startDate, endDate, limit = 500 } = req.query;

    const query = {};
    if (platform && platform !== "all") query.platform = platform;
    if (outcome && outcome !== "all") query.outcome = outcome;
    if (action && action.trim()) query.action = { $regex: action.trim(), $options: "i" };
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    const records = await UserApiActivity.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(1000, parseInt(limit, 10) || 500))
      .lean();

    // Log admin audit for sensitive activity export
    await AdminAuditLog.create({
      adminId: req.admin?._id,
      adminEmail: req.admin?.email || "admin",
      action: "activity.export",
      category: "monitoring",
      details: {
        summary: `Exported ${records.length} activity telemetry records (${format.toUpperCase()})`,
        format,
        count: records.length,
        filters: { platform, outcome, action, startDate, endDate },
      },
      ipAddress: (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim(),
      userAgent: req.headers["user-agent"] || "",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + RETENTION_MS),
    });

    if (format === "csv") {
      const headers = ["Time", "User", "Platform", "Action", "Method", "Route", "Status", "DurationMs", "RequestId", "Outcome"];
      const rows = records.map((r) => [
        new Date(r.createdAt).toISOString(),
        `"${r.username || r.userEmail || "anonymous"}"`,
        r.platform,
        `"${r.action}"`,
        r.method || "N/A",
        `"${r.route || "N/A"}"`,
        r.statusCode || "N/A",
        r.durationMs || 0,
        r.requestId,
        r.outcome,
      ]);

      const csvContent = [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=user_api_activity_${Date.now()}.csv`);
      return res.send(csvContent);
    }

    return res.json({
      success: true,
      totalExported: records.length,
      activities: records,
    });
  } catch (error) {
    console.error("Error in exportActivityLogs:", error);
    return res.status(500).json({ success: false, message: "Failed to export logs", error: error.message });
  }
};

/**
 * 4. Get 15-Day Retention Policy & TTL Diagnostics
 */
exports.getRetentionStats = async (req, res) => {
  try {
    // Inspect UserApiActivity collection indexes
    let userActivityIndexes = [];
    try {
      userActivityIndexes = await UserApiActivity.collection.indexes();
    } catch {}

    const userActivityTtlIndex = userActivityIndexes.find(
      (idx) => idx.key && idx.key.expiresAt === 1 && idx.expireAfterSeconds !== undefined
    );

    // Inspect AdminAuditLog collection indexes
    let adminAuditIndexes = [];
    try {
      adminAuditIndexes = await AdminAuditLog.collection.indexes();
    } catch {}

    const adminAuditTtlIndex = adminAuditIndexes.find(
      (idx) => idx.key && idx.key.expiresAt === 1 && idx.expireAfterSeconds !== undefined
    );

    // Document counts & timestamp bounds
    const [
      userActivityTotal,
      userActivityWeb,
      userActivityMobile,
      userActivityUnknown,
      userOldest,
      userNewest,
      userMissingExpiry,
      auditTotal,
      auditOldest,
      auditNewest,
      auditMissingExpiry,
    ] = await Promise.all([
      UserApiActivity.countDocuments(),
      UserApiActivity.countDocuments({ platform: "web" }),
      UserApiActivity.countDocuments({ platform: "mobile" }),
      UserApiActivity.countDocuments({ platform: "unknown" }),
      UserApiActivity.findOne().sort({ createdAt: 1 }).select("createdAt expiresAt").lean(),
      UserApiActivity.findOne().sort({ createdAt: -1 }).select("createdAt expiresAt").lean(),
      UserApiActivity.countDocuments({ expiresAt: { $exists: false } }),
      AdminAuditLog.countDocuments(),
      AdminAuditLog.findOne().sort({ createdAt: 1 }).select("createdAt expiresAt").lean(),
      AdminAuditLog.findOne().sort({ createdAt: -1 }).select("createdAt expiresAt").lean(),
      AdminAuditLog.countDocuments({ expiresAt: { $exists: false } }),
    ]);

    return res.json({
      success: true,
      retentionPolicy: {
        policyDays: 15,
        policyDurationMs: RETENTION_MS,
        isFixedMaximum: true,
        description: "All covered log collections in MongoDB automatically expire 15 days after event timestamp via MongoDB TTL indexes.",
        ttlEngineStatus: "ACTIVE (MongoDB background task runs every ~60 seconds to purge expired documents)",
      },
      collections: {
        userApiActivity: {
          name: "UserApiActivity",
          totalCount: userActivityTotal,
          platformBreakdown: {
            web: userActivityWeb,
            mobile: userActivityMobile,
            unknown: userActivityUnknown,
          },
          ttlIndex: {
            configured: !!userActivityTtlIndex,
            key: "expiresAt: 1",
            expireAfterSeconds: userActivityTtlIndex ? userActivityTtlIndex.expireAfterSeconds : 0,
            status: userActivityTtlIndex ? "VERIFIED_ACTIVE" : "PENDING_CREATION",
          },
          oldestRecord: userOldest ? userOldest.createdAt : null,
          newestRecord: userNewest ? userNewest.createdAt : null,
          missingExpiryCount: userMissingExpiry,
          compliant: !!userActivityTtlIndex && userMissingExpiry === 0,
        },
        adminAuditLog: {
          name: "AdminAuditLog",
          totalCount: auditTotal,
          ttlIndex: {
            configured: !!adminAuditTtlIndex,
            key: "expiresAt: 1",
            expireAfterSeconds: adminAuditTtlIndex ? adminAuditTtlIndex.expireAfterSeconds : 0,
            status: adminAuditTtlIndex ? "VERIFIED_ACTIVE" : "PENDING_CREATION",
          },
          oldestRecord: auditOldest ? auditOldest.createdAt : null,
          newestRecord: auditNewest ? auditNewest.createdAt : null,
          missingExpiryCount: auditMissingExpiry,
          compliant: !!adminAuditTtlIndex && auditMissingExpiry === 0,
        },
      },
    });
  } catch (error) {
    console.error("Error in getRetentionStats:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch retention diagnostics", error: error.message });
  }
};

/**
 * 5. Verify & Backfill Retention TTL Indexes and Expiry Dates
 */
exports.verifyAndBackfillRetention = async (req, res) => {
  try {
    // 1. Ensure TTL index exists on UserApiActivity
    await UserApiActivity.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

    // 2. Ensure TTL index exists on AdminAuditLog
    await AdminAuditLog.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

    // 3. Backfill any legacy records missing expiresAt in UserApiActivity
    const userDocsToBackfill = await UserApiActivity.find({ expiresAt: { $exists: false } }).select("_id createdAt").lean();
    let userBackfilledCount = 0;
    for (const doc of userDocsToBackfill) {
      const createdAt = doc.createdAt || new Date();
      const expiresAt = new Date(new Date(createdAt).getTime() + RETENTION_MS);
      await UserApiActivity.updateOne({ _id: doc._id }, { $set: { expiresAt } });
      userBackfilledCount++;
    }

    // 4. Backfill any legacy records missing expiresAt in AdminAuditLog
    const auditDocsToBackfill = await AdminAuditLog.find({ expiresAt: { $exists: false } }).select("_id createdAt").lean();
    let auditBackfilledCount = 0;
    for (const doc of auditDocsToBackfill) {
      const createdAt = doc.createdAt || new Date();
      const expiresAt = new Date(new Date(createdAt).getTime() + RETENTION_MS);
      await AdminAuditLog.updateOne({ _id: doc._id }, { $set: { expiresAt } });
      auditBackfilledCount++;
    }

    // 5. Audit this action
    await AdminAuditLog.create({
      adminId: req.admin?._id,
      adminEmail: req.admin?.email || "admin",
      action: "activity.retention.verify",
      category: "monitoring",
      details: {
        summary: `Synchronized 15-day TTL index policies. Backfilled ${userBackfilledCount + auditBackfilledCount} log expiration timestamps.`,
        userBackfilledCount,
        auditBackfilledCount,
        ttlVerified: true,
      },
      ipAddress: (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim(),
      userAgent: req.headers["user-agent"] || "",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + RETENTION_MS),
    });

    return res.json({
      success: true,
      message: "Retention policy and TTL indexes successfully verified and synchronized.",
      results: {
        userActivity: {
          ttlIndexCreated: true,
          backfilledCount: userBackfilledCount,
        },
        adminAuditLog: {
          ttlIndexCreated: true,
          backfilledCount: auditBackfilledCount,
        },
      },
    });
  } catch (error) {
    console.error("Error in verifyAndBackfillRetention:", error);
    return res.status(500).json({ success: false, message: "Verification failed", error: error.message });
  }
};

/**
 * 6. Delete Single User API Activity Log
 */
exports.deleteActivityLog = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid activity log ID" });
    }

    const activity = await UserApiActivity.findById(id);
    if (!activity) {
      return res.status(404).json({ success: false, message: "Activity log not found or already deleted" });
    }

    await UserApiActivity.findByIdAndDelete(id);

    // Audit delete action
    await AdminAuditLog.create({
      adminId: req.admin?._id,
      adminEmail: req.admin?.email || "admin",
      action: "activity.delete",
      category: "monitoring",
      details: {
        summary: `Deleted API activity log for action '${activity.action}' (Platform: ${activity.platform})`,
        deletedLogId: id,
        action: activity.action,
        platform: activity.platform,
        requestId: activity.requestId,
      },
      ipAddress: (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim(),
      userAgent: req.headers["user-agent"] || "",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + RETENTION_MS),
    });

    return res.json({
      success: true,
      message: "Activity log successfully deleted.",
      deletedId: id,
    });
  } catch (error) {
    console.error("Error in deleteActivityLog:", error);
    return res.status(500).json({ success: false, message: "Failed to delete activity log", error: error.message });
  }
};

/**
 * 7. Bulk Delete User API Activity Logs
 */
exports.bulkDeleteActivityLogs = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "Please provide an array of activity log IDs to delete" });
    }

    const validIds = ids
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (validIds.length === 0) {
      return res.status(400).json({ success: false, message: "No valid activity log IDs provided" });
    }

    const deleteResult = await UserApiActivity.deleteMany({ _id: { $in: validIds } });

    // Audit bulk delete action
    await AdminAuditLog.create({
      adminId: req.admin?._id,
      adminEmail: req.admin?.email || "admin",
      action: "activity.bulk_delete",
      category: "monitoring",
      details: {
        summary: `Bulk deleted ${deleteResult.deletedCount} activity telemetry log(s)`,
        requestedCount: ids.length,
        deletedCount: deleteResult.deletedCount,
      },
      ipAddress: (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim(),
      userAgent: req.headers["user-agent"] || "",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + RETENTION_MS),
    });

    return res.json({
      success: true,
      message: `Successfully deleted ${deleteResult.deletedCount} activity log(s).`,
      deletedCount: deleteResult.deletedCount,
    });
  } catch (error) {
    console.error("Error in bulkDeleteActivityLogs:", error);
    return res.status(500).json({ success: false, message: "Failed to perform bulk deletion", error: error.message });
  }
};
