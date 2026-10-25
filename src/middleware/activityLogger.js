const crypto = require("crypto");
const { recordHttpActivity } = require("../utils/activityLoggerService");

/**
 * Express middleware to assign request IDs, measure response duration,
 * and asynchronously record user API activity.
 */
const activityLoggerMiddleware = (req, res, next) => {
  // Fast pass for CORS preflight OPTIONS requests
  if (req.method === "OPTIONS") {
    return next();
  }

  // Attach or generate unique Request ID
  const requestId = req.headers["x-request-id"] || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  const startTime = Date.now();

  // Listen for the response finish event
  res.on("finish", () => {
    const durationMs = Date.now() - startTime;
    recordHttpActivity({
      req,
      res,
      durationMs,
    }).catch(() => {});
  });

  next();
};

module.exports = activityLoggerMiddleware;
