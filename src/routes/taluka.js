const express = require("express");
const router = express.Router();
const talukaController = require("../controllers/talukaController");
const auth = require("../middleware/auth");

/**
 * @swagger
 * tags:
 *   name: Talukas
 *   description: Taluka management endpoints
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Taluka:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: The taluka ID
 *         number:
 *           type: integer
 *           description: 2-digit number for the taluka
 *           minimum: 1
 *           maximum: 99
 *         abbreviation:
 *           type: string
 *           description: Abbreviation of the taluka
 *           maxLength: 10
 *         talukaName:
 *           type: string
 *           description: Full name of the taluka
 *           maxLength: 100
 *         createdAt:
 *           type: string
 *           format: date-time
 *           description: Creation timestamp
 *         updatedAt:
 *           type: string
 *           format: date-time
 *           description: Last update timestamp
 */

/**
 * @swagger
 * /talukas:
 *   get:
 *     summary: Get all talukas
 *     tags: [Talukas]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of talukas per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search term for taluka name or abbreviation
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           default: number
 *         description: Field to sort by
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: asc
 *         description: Sort order
 *     responses:
 *       200:
 *         description: List of talukas
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 talukas:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Taluka'
 *                 page:
 *                   type: integer
 *                 totalPages:
 *                   type: integer
 *                 totalTalukas:
 *                   type: integer
 *       401:
 *         description: Unauthorized
 */
router.get("/", auth, talukaController.getTalukas);

/**
 * @swagger
 * /talukas/{id}:
 *   get:
 *     summary: Get taluka by ID
 *     tags: [Talukas]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Taluka ID
 *     responses:
 *       200:
 *         description: Taluka data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Taluka'
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Taluka not found
 */
router.get("/:id", auth, talukaController.getTalukaById);

/**
 * @swagger
 * /talukas:
 *   post:
 *     summary: Create a new taluka
 *     tags: [Talukas]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               number:
 *                 type: integer
 *                 description: 2-digit number for the taluka
 *                 minimum: 1
 *                 maximum: 99
 *               abbreviation:
 *                 type: string
 *                 description: Abbreviation of the taluka (uppercase)
 *                 maxLength: 10
 *               talukaName:
 *                 type: string
 *                 description: Full name of the taluka
 *                 maxLength: 100
 *             required:
 *               - number
 *               - abbreviation
 *               - talukaName
 *     responses:
 *       201:
 *         description: Taluka created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Taluka'
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 */
router.post("/", auth, talukaController.createTaluka);

/**
 * @swagger
 * /talukas/{id}:
 *   put:
 *     summary: Update taluka by ID
 *     tags: [Talukas]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Taluka ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               number:
 *                 type: integer
 *                 description: 2-digit number for the taluka
 *                 minimum: 1
 *                 maximum: 99
 *               abbreviation:
 *                 type: string
 *                 description: Abbreviation of the taluka (uppercase)
 *                 maxLength: 10
 *               talukaName:
 *                 type: string
 *                 description: Full name of the taluka
 *                 maxLength: 100
 *     responses:
 *       200:
 *         description: Taluka updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Taluka'
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Taluka not found
 */
router.put("/:id", auth, talukaController.updateTaluka);

/**
 * @swagger
 * /talukas/{id}:
 *   delete:
 *     summary: Delete taluka by ID
 *     tags: [Talukas]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Taluka ID
 *     responses:
 *       200:
 *         description: Taluka deleted successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Taluka not found
 */
router.delete("/:id", auth, talukaController.deleteTaluka);

module.exports = router;
