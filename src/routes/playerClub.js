const express = require("express");
const router = express.Router();
const {
  getPlayerClubHistory,
  getClubPlayers,
  getPlayerActiveClub,
  requestPlayerTransfer,
  deactivatePlayer,
  getTransferStats,
} = require("../controllers/playerClubController");

// Get player's club history
router.get("/player/:playerId/history", getPlayerClubHistory);

// Get player's current active club
router.get("/player/:playerId/active", getPlayerActiveClub);

// Get club's players (active and inactive)
router.get("/club/:clubId/players", getClubPlayers);

// Request player transfer to new club
router.post("/transfer", requestPlayerTransfer);

// Deactivate player from current club
router.post("/deactivate", deactivatePlayer);

// Get transfer statistics
router.get("/stats", getTransferStats);

module.exports = router;
