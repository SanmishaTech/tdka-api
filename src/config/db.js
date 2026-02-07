const { PrismaClient } = require("@prisma/client");
const { getRequestFromContext } = require("../middleware/activityLogContext");

const basePrisma = new PrismaClient();

const SKIPPED_MODELS = new Set(["ActivityLog"]);
const ALLOWED_ACTIONS = new Set(["create", "update", "delete", "updateMany", "deleteMany"]);

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
  if (
    f.includes("password") ||
    f.includes("pass") ||
    f.includes("secret") ||
    f.includes("token") ||
    f.includes("otp") ||
    f.includes("pin") ||
    f.includes("clientsecret") ||
    f.includes("client_secret")
  ) {
    return "[REDACTED]";
  }
  if (f.includes("aadhar") || f.includes("aadhaar")) return maskAadhaar(value);
  return value;
};

const normalizeComparable = (v) => (v instanceof Date ? v.toISOString() : v);

const isScalarLike = (v) => {
  if (v === null || v === undefined) return true;
  if (v instanceof Date) return true;
  const t = typeof v;
  return t === "string" || t === "number" || t === "boolean";
};

const diffObjects = (before, after) => {
  const keys = new Set([...(before ? Object.keys(before) : []), ...(after ? Object.keys(after) : [])]);
  const diff = {};
  for (const k of keys) {
    const oldRaw = before ? before[k] : undefined;
    const newRaw = after ? after[k] : undefined;

    // Skip nested objects/arrays (relations, includes) to keep logs small and safe
    if (!isScalarLike(oldRaw) || !isScalarLike(newRaw)) {
      continue;
    }

    const oldVal = normalizeComparable(oldRaw);
    const newVal = normalizeComparable(newRaw);
    if (oldVal !== newVal) {
      diff[k] = { old: maskValueForField(k, oldVal), new: maskValueForField(k, newVal) };
    }
  }
  return diff;
};

const pickId = (obj) => {
  if (!obj) return null;
  if (obj.id !== undefined && obj.id !== null) return obj.id;
  return null;
};

const lowerFirst = (s) => (s ? `${s.charAt(0).toLowerCase()}${s.slice(1)}` : s);

const getWhereId = (where) => {
  if (!where) return null;
  if (where.id !== undefined && where.id !== null) return where.id;
  if (typeof where === "object") {
    const keys = Object.keys(where);
    if (keys.length === 1 && where[keys[0]] !== undefined) {
      const v = where[keys[0]];
      if (typeof v !== "object" && v !== null) return v;
    }
  }
  return null;
};

const writeActivityLog = async ({ action, entityType, entityId, changes }) => {
  try {
    if (!prisma?.activityLog) return;

    const req = getRequestFromContext();

    const bodyEmail =
      (req?.body?.email && String(req.body.email)) ||
      (req?.body?.username && String(req.body.username)) ||
      null;

    const bodyName = (req?.body?.name && String(req.body.name)) || null;

    let actorRole = req?.user?.role ? String(req.user.role) : null;
    let actorName = (req?.user?.name && String(req.user.name)) || bodyName;
    let actorEmail = (req?.user?.email && String(req.user.email)) || bodyEmail;

    let actorId = req?.user?.id !== undefined && req?.user?.id !== null ? String(req.user.id) : null;
    if (!actorId && String(entityType) === "User" && entityId !== undefined && entityId !== null) {
      actorId = String(entityId);
    }

    // Login/update before auth middleware runs: enrich actor from DB using email
    if ((!actorName || !actorRole || !actorId) && actorEmail && prisma?.user?.findUnique) {
      try {
        const u = await prisma.user.findUnique({
          where: { email: actorEmail },
          select: { id: true, name: true, role: true, email: true },
        });
        if (u) {
          if (!actorId && u.id !== undefined && u.id !== null) actorId = String(u.id);
          if (!actorName && u.name) actorName = String(u.name);
          if (!actorRole && u.role) actorRole = String(u.role);
          if (!actorEmail && u.email) actorEmail = String(u.email);
        }
      } catch (_) {
        // ignore lookup errors
      }
    }

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
    console.error("[ActivityLog] Prisma middleware failed", err?.message || err);
  }
};

// Activity logging middleware using Prisma Client Extensions (Prisma 5+)
const prisma = basePrisma.$extends({
  query: {
    $allOperations: async ({ model, operation, args, query }) => {
      try {
        // Skip if no model or if it's a skipped model or not an allowed action
        if (!model || SKIPPED_MODELS.has(model) || !ALLOWED_ACTIONS.has(operation)) {
          return query(args);
        }

        const delegateKey = lowerFirst(model);
        const delegate = basePrisma[delegateKey];

        // For update/delete: capture before
        let before = null;
        if (operation === "update" || operation === "delete") {
          const id = getWhereId(args?.where);
          if (id !== null && delegate?.findUnique) {
            before = await delegate.findUnique({ where: { id } });
          }
        }

        const result = await query(args);

        // For create/update/delete: capture after and diff
        if (operation === "create") {
          const entityId = pickId(result);
          await writeActivityLog({
            action: `${model.toUpperCase()}_CREATE`,
            entityType: model,
            entityId,
            changes: diffObjects(null, result),
          });
        } else if (operation === "update") {
          const entityId = pickId(result) ?? getWhereId(args?.where);
          const changes = diffObjects(before, result);
          if (Object.keys(changes).length > 0) {
            await writeActivityLog({
              action: `${model.toUpperCase()}_UPDATE`,
              entityType: model,
              entityId,
              changes,
            });
          }
        } else if (operation === "delete") {
          const entityId = pickId(before) ?? getWhereId(args?.where);
          await writeActivityLog({
            action: `${model.toUpperCase()}_DELETE`,
            entityType: model,
            entityId,
            changes: diffObjects(before, null),
          });
        } else if (operation === "updateMany" || operation === "deleteMany") {
          // keep it lightweight: just a summary (no per-row before/after)
          await writeActivityLog({
            action: `${model.toUpperCase()}_${operation.toUpperCase()}`,
            entityType: model,
            entityId: null,
            changes: {
              where: { old: null, new: args?.where || null },
              count: { old: null, new: result?.count ?? null },
            },
          });
        }

        return result;
      } catch (err) {
        // Never break main flow
        console.error("[ActivityLog] Prisma middleware error", err?.message || err);
        return query(args);
      }
    },
  },
});

module.exports = prisma;

