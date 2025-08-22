const jwt = require("jsonwebtoken");
const createError = require("http-errors");
const { secret } = require("../config/jwt");
const prisma = require("../config/db");
const { checkMembershipExpiry } = require("../services/membershipService");

module.exports = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return next(createError(401, "Unauthorized"));
  }
  try {
    const decoded = jwt.verify(token, secret);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
    });
    if (!user) {
      return next(createError(401, "Unauthorized"));
    }

    // Check membership expiry for members
    if (user.role.includes('member')) {
      const { active, expiryInfo } = await checkMembershipExpiry(user.id);
      
      // Update user object with current active status
      user.active = active;
      
      // Attach expiry info to request if available
      if (expiryInfo) {
        req.membershipExpiryInfo = expiryInfo;
      }
      
      // If membership has expired, update user's active status and return 403
      if (!active) {
        return next(createError(403, "Your membership has expired. Please contact your administrator."));
      }
    }

    // Enforce observer access window based on assigned competition dates (any active allows access)
    if (typeof user.role === 'string' && user.role.toLowerCase() === 'observer') {
      const competitions = await prisma.competition.findMany({
        where: { observerId: user.id },
        select: { id: true, fromDate: true, toDate: true },
      });

      if (!competitions || competitions.length === 0) {
        return next(createError(403, 'Observer is not assigned to any competition'));
      }

      const now = new Date();
      const ranges = competitions
        .map((c) => {
          const start = new Date(c.fromDate);
          const end = new Date(c.toDate);
          if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
          start.setHours(0, 0, 0, 0);
          end.setHours(23, 59, 59, 999);
          return { start, end, c };
        })
        .filter(Boolean);

      if (ranges.length === 0) {
        return next(createError(500, 'Invalid competition date configuration for observer access'));
      }

      const anyActive = ranges.some(({ start, end }) => now >= start && now <= end);
      if (!anyActive) {
        const upcoming = ranges
          .filter(({ start }) => start > now)
          .sort((a, b) => a.start.getTime() - b.start.getTime());
        if (upcoming.length > 0) {
          return next(createError(403, `Observer access not yet active. Starts on ${upcoming[0].c.fromDate}`));
        }
        return next(createError(403, 'Observer access period has expired'));
      }
    }

    req.user = user;
    next();
  } catch (error) {
    return next(createError(401, "Unauthorized"));
  }
};
