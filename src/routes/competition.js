const express = require("express");
const competitionController = require("../controllers/competitionController");
const auth = require("../middleware/auth");

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Competitions
 *   description: Competition management endpoints
 */

/**
 * @swagger
 * /competitions:
 *   get:
 *     summary: Get all competitions
 *     tags: [Competitions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Number of items per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search term for competition name or age
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *         description: Field to sort by
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *         description: Sort order
 *     responses:
 *       200:
 *         description: List of all competitions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 competitions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Competition'
 *                 page:
 *                   type: integer
 *                 totalPages:
 *                   type: integer
 *                 totalCompetitions:
 *                   type: integer
 */
router.get("/", auth, competitionController.getCompetitions);

/**
 * @swagger
 * /competitions/{id}:
 *   get:
 *     summary: Get a competition by ID
 *     tags: [Competitions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Competition ID
 *     responses:
 *       200:
 *         description: Competition data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Competition'
 *       404:
 *         description: Competition not found
 */
router.get("/:id", auth, competitionController.getCompetition);

/**
 * @swagger
 * /competitions:
 *   post:
 *     summary: Create a new competition
 *     tags: [Competitions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - competitionName
 *               - date
 *               - age
 *               - lastEntryDate
 *             properties:
 *               competitionName:
 *                 type: string
 *                 description: Name of the competition
 *                 example: "Summer Championship"
 *               date:
 *                 type: string
 *                 description: Date of the competition
 *                 example: "2025-08-15"
 *               age:
 *                 type: string
 *                 description: Age category for the competition
 *                 example: "16-18"
 *               lastEntryDate:
 *                 type: string
 *                 description: Last date for entries
 *                 example: "2025-07-31"
 *     responses:
 *       201:
 *         description: Competition created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Competition'
 *       400:
 *         description: Validation error
 */
router.post("/", auth, competitionController.createCompetition);

/**
 * @swagger
 * /competitions/{id}:
 *   put:
 *     summary: Update a competition by ID
 *     tags: [Competitions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Competition ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               competitionName:
 *                 type: string
 *                 description: Name of the competition
 *               date:
 *                 type: string
 *                 description: Date of the competition
 *               age:
 *                 type: string
 *                 description: Age category for the competition
 *               lastEntryDate:
 *                 type: string
 *                 description: Last date for entries
 *     responses:
 *       200:
 *         description: Competition updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Competition'
 *       404:
 *         description: Competition not found
 *       400:
 *         description: Validation error
 */
router.put("/:id", auth, competitionController.updateCompetition);

/**
 * @swagger
 * /competitions/{id}:
 *   delete:
 *     summary: Delete a competition by ID
 *     tags: [Competitions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Competition ID
 *     responses:
 *       200:
 *         description: Competition deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Competition deleted successfully"
 *       404:
 *         description: Competition not found
 */
router.delete("/:id", auth, competitionController.deleteCompetition);

module.exports = router;