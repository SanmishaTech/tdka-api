const express = require("express");
const router = express.Router();
const regionController = require("../controllers/regionController");
const auth = require("../middleware/auth");

/**
 * @swagger
 * tags:
 *   name: Regions
 *   description: Region management endpoints
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Region:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: The region ID
 *         number:
 *           type: integer
 *           description: 2-digit number for the region
 *           minimum: 1
 *           maximum: 99
 *         abbreviation:
 *           type: string
 *           description: Abbreviation of the region
 *           maxLength: 10
 *         regionName:
 *           type: string
 *           description: Full name of the region
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
 * /regions:
 *   get:
 *     summary: Get all regions
 *     tags: [Regions]
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
 *         description: Number of regions per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search term for region name or abbreviation
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
 *         description: List of regions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 regions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Region'
 *                 page:
 *                   type: integer
 *                 totalPages:
 *                   type: integer
 *                 totalRegions:
 *                   type: integer
 *       401:
 *         description: Unauthorized
 */
router.get("/", auth, regionController.getRegions);

/**
 * @swagger
 * /regions/{id}:
 *   get:
 *     summary: Get region by ID
 *     tags: [Regions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Region ID
 *     responses:
 *       200:
 *         description: Region data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Region'
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Region not found
 */
router.get("/:id", auth, regionController.getRegionById);

/**
 * @swagger
 * /regions:
 *   post:
 *     summary: Create a new region
 *     tags: [Regions]
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
 *                 description: 2-digit number for the region
 *                 minimum: 1
 *                 maximum: 99
 *               abbreviation:
 *                 type: string
 *                 description: Abbreviation of the region (uppercase)
 *                 maxLength: 10
 *               regionName:
 *                 type: string
 *                 description: Full name of the region
 *                 maxLength: 100
 *             required:
 *               - number
 *               - abbreviation
 *               - regionName
 *     responses:
 *       201:
 *         description: Region created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Region'
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 */
router.post("/", auth, regionController.createRegion);

/**
 * @swagger
 * /regions/{id}:
 *   put:
 *     summary: Update region by ID
 *     tags: [Regions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Region ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               number:
 *                 type: integer
 *                 description: 2-digit number for the region
 *                 minimum: 1
 *                 maximum: 99
 *               abbreviation:
 *                 type: string
 *                 description: Abbreviation of the region (uppercase)
 *                 maxLength: 10
 *               regionName:
 *                 type: string
 *                 description: Full name of the region
 *                 maxLength: 100
 *     responses:
 *       200:
 *         description: Region updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Region'
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Region not found
 */
router.put("/:id", auth, regionController.updateRegion);

/**
 * @swagger
 * /regions/{id}:
 *   delete:
 *     summary: Delete region by ID
 *     tags: [Regions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Region ID
 *     responses:
 *       200:
 *         description: Region deleted successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Region not found
 */
router.delete("/:id", auth, regionController.deleteRegion);

module.exports = router;
