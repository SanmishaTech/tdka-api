const prisma = require("../config/db");

const safeJsonStringify = (value) => {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return undefined;
  }
};

const maskAadhaar = (value) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return value;
  const last4 = digits.slice(-4);
  return `XXXX-XXXX-${last4}`;
};

const maskValueForField = (field, value) => {
  const f = String(field || "").toLowerCase();
  if (f.includes("password")) return "[REDACTED]";
  if (f.includes("aadhar")) return maskAadhaar(value);
  return value;
};

const diffRecords = (before, after, fields) => {
  const diff = {};
  for (const key of fields) {
    const oldVal = before ? before[key] : undefined;
    const newVal = after ? after[key] : undefined;

    const oldComparable = oldVal instanceof Date ? oldVal.toISOString() : oldVal;
    const newComparable = newVal instanceof Date ? newVal.toISOString() : newVal;

    if (oldComparable !== newComparable) {
      diff[key] = {
        old: maskValueForField(key, oldComparable),
        new: maskValueForField(key, newComparable),
      };
    }
  }
  return diff;
};

const buildCreateChanges = (after, fields) => {
  const changes = {};
  for (const key of fields) {
    const newVal = after ? after[key] : undefined;
    const newComparable = newVal instanceof Date ? newVal.toISOString() : newVal;
    if (newComparable !== undefined) {
      changes[key] = { old: null, new: maskValueForField(key, newComparable) };
    }
  }
  return changes;
};

const buildDeleteChanges = (before, fields) => {
  const changes = {};
  for (const key of fields) {
    const oldVal = before ? before[key] : undefined;
    const oldComparable = oldVal instanceof Date ? oldVal.toISOString() : oldVal;
    if (oldComparable !== undefined) {
      changes[key] = { old: maskValueForField(key, oldComparable), new: null };
    }
  }
  return changes;
};

const logActivity = async ({
  req,
  action,
  entityType,
  entityId,
  changes,
}) => {
  try {
    if (!prisma?.activityLog) {
      return;
    }

    const actorRole = req?.user?.role ? String(req.user.role) : null;
    const actorName = req?.user?.name ? String(req.user.name) : null;
    const actorEmail = req?.user?.email ? String(req.user.email) : null;
    const actorId = req?.user?.id !== undefined && req?.user?.id !== null ? String(req.user.id) : null;

    const ipAddress =
      (req?.headers?.["x-forwarded-for"] && String(req.headers["x-forwarded-for"]).split(",")[0].trim()) ||
      req?.ip ||
      null;

    const userAgent = req?.headers?.["user-agent"] ? String(req.headers["user-agent"]) : null;

    await prisma.activityLog.create({
      data: {
        action: String(action || "").trim() || "UNKNOWN",
        entityType: String(entityType || "").trim() || "UNKNOWN",
        entityId: entityId !== undefined && entityId !== null ? String(entityId) : null,
        actorRole,
        actorName,
        actorEmail,
        actorId,
        ipAddress,
        userAgent,
        changes: typeof changes === "string" ? changes : safeJsonStringify(changes),
      },
    });
  } catch (err) {
    // Activity logs should never break the main API flow
    console.error("[ActivityLog] Failed to write log", err?.message || err);
  }
};

module.exports = {
  logActivity,
  diffRecords,
  buildCreateChanges,
  buildDeleteChanges,
};
