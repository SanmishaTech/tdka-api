const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const activityLogController = require("../controllers/activityLogController");

const requireAdmin = (req, res, next) => {
  if (!req.user || String(req.user.role || "").toLowerCase() !== "admin") {
    return res.status(403).json({
      errors: { message: "Access denied" },
    });
  }
  next();
};

router.get("/", auth, requireAdmin, activityLogController.listActivityLogs);

module.exports = router;
