const express = require("express");
const clubController = require("../controllers/clubController");
const auth = require("../middleware/auth");
const createUploadMiddleware = require("../middleware/uploadMiddleware");

const router = express.Router();

// Upload middleware configuration for club Excel import
const clubExcelUpload = createUploadMiddleware(
  "clubs",
  [
    {
      name: "file",
      allowedTypes: [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
      ],
      maxSize: 5 * 1024 * 1024, // 5MB
    },
  ]
);

/**
 * @swagger
 * tags:
 *   name: Clubs
 *   description: Club management endpoints
 */

/**
 * @swagger
 * /clubs/regions:
 *   get:
 *     summary: Get all regions for dropdown
 *     tags: [Clubs]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of all regions with taluka info
 */
router.get("/regions", auth, clubController.getPlaces);

/**
 * @swagger
 * /clubs/import:
 *   post:
 *     summary: Import clubs from Excel
 *     tags: [Clubs]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *             required:
 *               - file
 *     responses:
 *       200:
 *         description: Import result summary
 */
router.post("/import", auth, ...clubExcelUpload, clubController.importClubs);

/**
 * @swagger
 * /clubs/import/template:
 *   get:
 *     summary: Download Excel template for club import
 *     tags: [Clubs]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Excel file with headers Club Name, Email, Region
 */
router.get("/import/template", auth, clubController.downloadClubImportTemplate);

router.get("/export", auth, clubController.exportClubs);

/**
 * @swagger
 * /clubs:
 *   get:
 *     summary: Get all clubs
 *     tags: [Clubs]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of all clubs
 */
router.get("/", auth, clubController.getClubs);

/**
 * @swagger
 * /clubs/{id}:
 *   get:
 *     summary: Get a club by ID
 *     tags: [Clubs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Club ID
 *     responses:
 *       200:
 *         description: Club data
 *       404:
 *         description: Club not found
 */
router.get("/:id", auth, clubController.getClub);

/**
 * @swagger
 * /clubs:
 *   post:
 *     summary: Create a new club
 *     tags: [Clubs]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Club'
 *     responses:
 *       201:
 *         description: Club created
 */
router.post("/", auth, clubController.createClub);

/**
 * @swagger
 * /clubs/{id}:
 *   put:
 *     summary: Update a club by ID
 *     tags: [Clubs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Club ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Club'
 *     responses:
 *       200:
 *         description: Club updated
 *       404:
 *         description: Club not found
 */
router.put("/:id", auth, clubController.updateClub);

/**
 * @swagger
 * /clubs/{id}:
 *   delete:
 *     summary: Delete a club by ID
 *     tags: [Clubs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Club ID
 *     responses:
 *       200:
 *         description: Club deleted
 *       404:
 *         description: Club not found
 */
router.delete("/:id", auth, clubController.deleteClub);

module.exports = router;
