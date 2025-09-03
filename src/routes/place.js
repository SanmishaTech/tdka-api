const express = require("express");
const router = express.Router();
const placeController = require("../controllers/placeController");
const auth = require("../middleware/auth");

/**
 * @swagger
 * tags:
 *   name: Places
 *   description: Place management endpoints
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Place:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: The place ID
 *         number:
 *           type: integer
 *           description: 2-digit number for the place
 *           minimum: 1
 *           maximum: 99
 *         abbreviation:
 *           type: string
 *           description: Abbreviation of the place
 *           maxLength: 10
 *         placeName:
 *           type: string
 *           description: Full name of the place
 *           maxLength: 100
 *         regionId:
 *           type: integer
 *           description: The region ID this place belongs to
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
 * /places:
 *   get:
 *     summary: Get all places
 *     tags: [Places]
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
 *         description: Number of places per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search term for place name or abbreviation
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
 *         description: List of places
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 places:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Place'
 *                 page:
 *                   type: integer
 *                 totalPages:
 *                   type: integer
 *                 totalPlaces:
 *                   type: integer
 *       401:
 *         description: Unauthorized
 */
router.get("/", auth, placeController.getPlaces);

/**
 * @swagger
 * /places/regions:
 *   get:
 *     summary: Get all regions for dropdown
 *     tags: [Places]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of regions
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: integer
 *                   regionName:
 *                     type: string
 *                   abbreviation:
 *                     type: string
 *                   number:
 *                     type: integer
 *       401:
 *         description: Unauthorized
 */
router.get("/regions", auth, placeController.getRegions);

/**
 * @swagger
 * /places/{id}:
 *   get:
 *     summary: Get place by ID
 *     tags: [Places]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Place ID
 *     responses:
 *       200:
 *         description: Place data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Place'
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Place not found
 */
router.get("/:id", auth, placeController.getPlaceById);

/**
 * @swagger
 * /places:
 *   post:
 *     summary: Create a new place
 *     tags: [Places]
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
 *                 description: 2-digit number for the place
 *                 minimum: 1
 *                 maximum: 99
 *               abbreviation:
 *                 type: string
 *                 description: Abbreviation of the place (uppercase)
 *                 maxLength: 10
 *               placeName:
 *                 type: string
 *                 description: Full name of the place
 *                 maxLength: 100
 *               regionId:
 *                 type: integer
 *                 description: The region ID this place belongs to
 *             required:
 *               - number
 *               - abbreviation
 *               - placeName
 *               - regionId
 *     responses:
 *       201:
 *         description: Place created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Place'
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 */
router.post("/", auth, placeController.createPlace);

/**
 * @swagger
 * /places/{id}:
 *   put:
 *     summary: Update place by ID
 *     tags: [Places]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Place ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               number:
 *                 type: integer
 *                 description: 2-digit number for the place
 *                 minimum: 1
 *                 maximum: 99
 *               abbreviation:
 *                 type: string
 *                 description: Abbreviation of the place (uppercase)
 *                 maxLength: 10
 *               placeName:
 *                 type: string
 *                 description: Full name of the place
 *                 maxLength: 100
 *               regionId:
 *                 type: integer
 *                 description: The region ID this place belongs to
 *     responses:
 *       200:
 *         description: Place updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Place'
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Place not found
 */
router.put("/:id", auth, placeController.updatePlace);

/**
 * @swagger
 * /places/{id}:
 *   delete:
 *     summary: Delete place by ID
 *     tags: [Places]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Place ID
 *     responses:
 *       200:
 *         description: Place deleted successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Place not found
 */
router.delete("/:id", auth, placeController.deletePlace);

module.exports = router;
