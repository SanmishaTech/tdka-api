const createError = require("http-errors");
const prisma = require("../config/db");

const requireAdmin = (req) => {
  const role = String(req.user?.role || "").toLowerCase();
  return role === "admin";
};

const listActivityLogs = async (req, res, next) => {
  try {
    if (!requireAdmin(req)) {
      throw createError(403, "Access denied");
    }

    if (!prisma?.activityLog) {
      return res.status(500).json({
        errors: {
          message:
            "Prisma Client is missing the ActivityLog model. Run `npm run generate` / `npx prisma generate` and restart the server.",
        },
      });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const {
      search = "",
      entityType,
      action,
      actorEmail,
      from,
      to,
      sortOrder = "desc",
    } = req.query;

    const where = {};

    if (entityType) where.entityType = String(entityType);
    if (action) where.action = String(action);
    if (actorEmail) where.actorEmail = { contains: String(actorEmail) };

    if (search) {
      where.OR = [
        { actorName: { contains: String(search) } },
        { actorEmail: { contains: String(search) } },
        { entityType: { contains: String(search) } },
        { entityId: { contains: String(search) } },
        { action: { contains: String(search) } },
      ];
    }

    if (from || to) {
      where.createdAt = {};
      if (from) {
        const d = new Date(String(from));
        if (!isNaN(d.getTime())) where.createdAt.gte = d;
      }
      if (to) {
        const d = new Date(String(to));
        if (!isNaN(d.getTime())) where.createdAt.lte = d;
      }
      if (Object.keys(where.createdAt).length === 0) {
        delete where.createdAt;
      }
    }

    const orderBy = { createdAt: String(sortOrder).toLowerCase() === "asc" ? "asc" : "desc" };

    const [logs, total] = await Promise.all([
      prisma.activityLog.findMany({
        where,
        orderBy,
        skip,
        take: limit,
      }),
      prisma.activityLog.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    res.json({
      logs,
      page,
      totalPages,
      totalLogs: total,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listActivityLogs,
};
