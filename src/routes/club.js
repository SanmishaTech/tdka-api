const express = require("express");
const clubController = require("../controllers/clubController");
const auth = require("../middleware/auth");

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Clubs
 *   description: Club management endpoints
 */

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
