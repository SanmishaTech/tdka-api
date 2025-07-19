const express = require("express");
const router = express.Router();
const playerController = require("../controllers/playerController");
const auth = require("../middleware/auth");
const acl = require("../middleware/acl");

/**
 * @swagger
 * tags:
 *   name: Players
 *   description: Player management endpoints
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Player:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: The player ID
 *         uniqueIdNumber:
 *           type: string
 *           description: Unique ID number for the player
 *         firstName:
 *           type: string
 *           description: Player's first name
 *         middleName:
 *           type: string
 *           description: Player's middle name (optional)
 *         lastName:
 *           type: string
 *           description: Player's last name
 *         profileImage:
 *           type: string
 *           description: Path to player's profile image
 *         dateOfBirth:
 *           type: string
 *           format: date
 *           description: Player's date of birth
 *         position:
 *           type: string
 *           description: Player's position
 *         address:
 *           type: string
 *           description: Player's address
 *         mobile:
 *           type: string
 *           description: Player's mobile number
 *         aadharNumber:
 *           type: string
 *           description: Player's Aadhar number
 *         aadharImage:
 *           type: string
 *           description: Path to player's Aadhar image
 *         aadharVerified:
 *           type: boolean
 *           description: Whether the Aadhar is verified
 *         isSuspended:
 *           type: boolean
 *           description: Whether the player is suspended
 *         createdAt:
 *           type: string
 *           format: date-time
 *           description: Creation timestamp
 *         updatedAt:
 *           type: string
 *           format: date-time
 *           description: Last update timestamp
 *         groups:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/Group'
 *           description: Groups the player belongs to
 */

/**
 * @swagger
 * /players:
 *   get:
 *     summary: Get all players
 *     tags: [Players]
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
 *         description: Number of players per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search term for player name, ID, or Aadhar
 *       - in: query
 *         name: isSuspended
 *         schema:
 *           type: boolean
 *         description: Filter by suspension status
 *       - in: query
 *         name: aadharVerified
 *         schema:
 *           type: boolean
 *         description: Filter by Aadhar verification status
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           default: id
 *         description: Field to sort by
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: asc
 *         description: Sort order
 *       - in: query
 *         name: export
 *         schema:
 *           type: boolean
 *         description: Export player data to Excel
 *     responses:
 *       200:
 *         description: List of players
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 players:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Player'
 *                 page:
 *                   type: integer
 *                 totalPages:
 *                   type: integer
 *                 totalPlayers:
 *                   type: integer
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get("/", auth, playerController.getPlayers);

/**
 * @swagger
 * /players/{id}:
 *   get:
 *     summary: Get player by ID
 *     tags: [Players]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Player ID
 *     responses:
 *       200:
 *         description: Player data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Player'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Player not found
 */
router.get("/:id", auth, playerController.getPlayerById);

/**
 * @swagger
 * /players:
 *   post:
 *     summary: Create a new player
 *     tags: [Players]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               firstName:
 *                 type: string
 *               middleName:
 *                 type: string
 *               lastName:
 *                 type: string
 *               dateOfBirth:
 *                 type: string
 *                 format: date
 *               position:
 *                 type: string
 *               address:
 *                 type: string
 *               mobile:
 *                 type: string
 *               aadharNumber:
 *                 type: string
 *               profileImage:
 *                 type: string
 *                 format: binary
 *               aadharImage:
 *                 type: string
 *                 format: binary
 *               groupIds:
 *                 type: array
 *                 items:
 *                   type: integer
 *             required:
 *               - firstName
 *               - lastName
 *               - dateOfBirth
 *               - address
 *               - mobile
 *               - aadharNumber
 *     responses:
 *       201:
 *         description: Player created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Player'
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.post("/", auth, playerController.createPlayer);

/**
 * @swagger
 * /players/{id}:
 *   put:
 *     summary: Update player by ID
 *     tags: [Players]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Player ID
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               firstName:
 *                 type: string
 *               middleName:
 *                 type: string
 *               lastName:
 *                 type: string
 *               dateOfBirth:
 *                 type: string
 *                 format: date
 *               position:
 *                 type: string
 *               address:
 *                 type: string
 *               mobile:
 *                 type: string
 *               aadharNumber:
 *                 type: string
 *               aadharVerified:
 *                 type: boolean
 *               profileImage:
 *                 type: string
 *                 format: binary
 *               aadharImage:
 *                 type: string
 *                 format: binary
 *               groupIds:
 *                 type: array
 *                 items:
 *                   type: integer
 *     responses:
 *       200:
 *         description: Player updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Player'
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Player not found
 */
router.put("/:id", auth, playerController.updatePlayer);

/**
 * @swagger
 * /players/{id}/suspension:
 *   patch:
 *     summary: Toggle player suspension status
 *     tags: [Players]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Player ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               isSuspended:
 *                 type: boolean
 *                 description: New suspension status
 *             required:
 *               - isSuspended
 *     responses:
 *       200:
 *         description: Player suspension status updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Player'
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Player not found
 */
router.patch("/:id/suspension", auth, playerController.toggleSuspension);

/**
 * @swagger
 * /players/{id}/aadhar-verification:
 *   patch:
 *     summary: Toggle player Aadhar verification status
 *     tags: [Players]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Player ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               aadharVerified:
 *                 type: boolean
 *                 description: New Aadhar verification status
 *             required:
 *               - aadharVerified
 *     responses:
 *       200:
 *         description: Player Aadhar verification status updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Player'
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Player not found
 */
router.patch("/:id/aadhar-verification", auth, playerController.toggleAadharVerification);

module.exports = router;