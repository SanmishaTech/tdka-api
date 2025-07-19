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

    req.user = user;
    next();
  } catch (error) {
    return next(createError(401, "Unauthorized"));
  }
};
