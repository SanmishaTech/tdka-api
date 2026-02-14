const express = require("express");
const router = express.Router();
const refereeController = require("../controllers/refereeController");
const auth = require("../middleware/auth");

const createUploadMiddleware = require("../middleware/uploadMiddleware");

const refereeUpload = createUploadMiddleware(
  "referees",
  [
    {
      name: "aadharImage",
      allowedTypes: ["image/jpeg", "image/jpg", "image/png"],
      maxSize: 2 * 1024 * 1024,
    },
    {
      name: "file", // For verification route
      allowedTypes: ["image/jpeg", "image/jpg", "image/png"],
      maxSize: 2 * 1024 * 1024,
    },
  ]
);

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
router.post("/", auth, requireAdmin, ...refereeUpload, refereeController.createReferee);
router.put("/:id", auth, requireAdmin, ...refereeUpload, refereeController.updateReferee);
router.delete("/:id", auth, requireAdmin, refereeController.deleteReferee);

// Aadhaar verification routes
router.post("/verify-aadhar", auth, requireAdmin, ...refereeUpload, refereeController.verifyAadharOCR);
router.post("/:id/verify-aadhar", auth, requireAdmin, ...refereeUpload, refereeController.verifyAadharOCR);

module.exports = router;
