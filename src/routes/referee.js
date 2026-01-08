const express = require("express");
const router = express.Router();
const refereeController = require("../controllers/refereeController");
const auth = require("../middleware/auth");

const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({
      errors: { message: "Access denied" },
    });
  }
  next();
};

router.get("/", auth, requireAdmin, refereeController.getReferees);
router.get("/:id", auth, requireAdmin, refereeController.getRefereeById);
router.post("/", auth, requireAdmin, refereeController.createReferee);
router.put("/:id", auth, requireAdmin, refereeController.updateReferee);
router.delete("/:id", auth, requireAdmin, refereeController.deleteReferee);

module.exports = router;
