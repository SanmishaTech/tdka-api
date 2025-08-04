const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient();
const { z } = require("zod");
const createError = require("http-errors");

/**
 * Wrap async route handlers and funnel errors through Express error middleware.
 * Converts Prisma validation errors and known request errors into structured 400 responses.
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch((err) => {
    // Zod or manual user errors forwarded by validateRequest
    if (err.status === 400 && err.expose) {
      return res
        .status(400)
        .json({ errors: err.errors || { message: err.message } });
    }
    // Prisma validation errors
    if (err.name === "PrismaClientValidationError") {
      return res.status(400).json({ errors: { message: err.message } });
    }
    // Prisma known request errors (e.g., unique constraint)
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2002" && err.meta?.target) {
        const field = Array.isArray(err.meta.target)
          ? err.meta.target[0]
          : err.meta.target;
        const message = `A record with that ${field} already exists.`;
        return res
          .status(400)
          .json({ errors: { [field]: { type: "unique", message } } });
      }
    }
    // Fallback for unexpected errors
    console.error(err);
    return res
      .status(500)
      .json({ errors: { message: "Internal Server Error" } });
  });
};

// Get player's club history
const getPlayerClubHistory = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.playerId);
  if (!playerId) throw createError(400, "Invalid player ID");

  const playerClubHistories = await prisma.playerClub.findMany({
    where: { playerId },
    include: {
      club: {
        select: {
          id: true,
          clubName: true,
          city: true,
        },
      },
    },
    orderBy: { joinedAt: 'desc' },
  });

  res.json(playerClubHistories);
});

// Get club's players (active and inactive)
const getClubPlayers = asyncHandler(async (req, res) => {
  const clubId = parseInt(req.params.clubId);
  if (!clubId) throw createError(400, "Invalid club ID");

  const { activeOnly = false } = req.query;
  
  const whereCondition = { clubId };
  if (activeOnly === 'true') {
    whereCondition.isActive = true;
  }

  const clubPlayers = await prisma.playerClub.findMany({
    where: whereCondition,
    include: {
      player: {
        select: {
          id: true,
          uniqueIdNumber: true,
          firstName: true,
          middleName: true,
          lastName: true,
          mobile: true,
          position: true,
          aadharVerified: true,
          isSuspended: true,
        },
      },
    },
    orderBy: [
      { isActive: 'desc' }, // Active players first
      { joinedAt: 'desc' },
    ],
  });

  res.json(clubPlayers);
});

// Get player's current active club
const getPlayerActiveClub = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.playerId);
  if (!playerId) throw createError(400, "Invalid player ID");

  const activeClub = await prisma.playerClub.findFirst({
    where: { 
      playerId,
      isActive: true 
    },
    include: {
      club: {
        select: {
          id: true,
          clubName: true,
          city: true,
        },
      },
    },
  });

  if (!activeClub) {
    return res.status(404).json({ message: "Player is not currently active in any club" });
  }

  res.json(activeClub);
});

// Request player transfer to new club
const requestPlayerTransfer = asyncHandler(async (req, res) => {
  const schema = z.object({
    playerId: z.number().min(1, "Player ID is required"),
    newClubId: z.number().min(1, "New club ID is required"),
    transferReason: z.string().optional(),
    approvedBy: z.string().optional(),
  });

  const validatedData = await schema.parseAsync(req.body);
  const { playerId, newClubId, transferReason, approvedBy } = validatedData;

  // Start transaction to ensure data consistency
  const result = await prisma.$transaction(async (tx) => {
    // 1. Check if player exists
    const player = await tx.player.findUnique({
      where: { id: playerId },
    });
    if (!player) throw createError(404, "Player not found");

    // 2. Check if new club exists
    const newClub = await tx.club.findUnique({
      where: { id: newClubId },
    });
    if (!newClub) throw createError(404, "New club not found");

    // 3. Find current active club (if any)
    const currentActiveClub = await tx.playerClub.findFirst({
      where: { 
        playerId,
        isActive: true 
      },
    });

    // 4. Check if player is already in the requested club
    if (currentActiveClub && currentActiveClub.clubId === newClubId) {
      throw createError(400, "Player is already active in this club");
    }

    // 5. Deactivate current club membership (if exists)
    if (currentActiveClub) {
      await tx.playerClub.update({
        where: { id: currentActiveClub.id },
        data: {
          isActive: false,
          leftAt: new Date(),
        },
      });
    }

    // 6. Check if player has previous history with new club
    const existingRelation = await tx.playerClub.findFirst({
      where: {
        playerId,
        clubId: newClubId,
      },
      orderBy: { joinedAt: 'desc' },
    });

    let newPlayerClub;

    if (existingRelation && !existingRelation.isActive) {
      // 7a. Reactivate existing relationship
      newPlayerClub = await tx.playerClub.update({
        where: { id: existingRelation.id },
        data: {
          isActive: true,
          joinedAt: new Date(), // Update join date for reactivation
          leftAt: null, // Clear left date
          transferReason,
          approvedBy,
        },
        include: {
          player: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              uniqueIdNumber: true,
            },
          },
          club: {
            select: {
              id: true,
              clubName: true,
              city: true,
            },
          },
        },
      });
    } else {
      // 7b. Create new relationship
      newPlayerClub = await tx.playerClub.create({
        data: {
          playerId,
          clubId: newClubId,
          isActive: true,
          transferReason,
          approvedBy,
        },
        include: {
          player: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              uniqueIdNumber: true,
            },
          },
          club: {
            select: {
              id: true,
              clubName: true,
              city: true,
            },
          },
        },
      });
    }

    return newPlayerClub;
  });

  res.status(201).json({
    message: "Player transfer completed successfully",
    playerClub: result,
  });
});

// Deactivate player from current club
const deactivatePlayer = asyncHandler(async (req, res) => {
  const schema = z.object({
    playerId: z.number().min(1, "Player ID is required"),
    transferReason: z.string().optional(),
    approvedBy: z.string().optional(),
  });

  const validatedData = await schema.parseAsync(req.body);
  const { playerId, transferReason, approvedBy } = validatedData;

  // Find current active club
  const activeClub = await prisma.playerClub.findFirst({
    where: { 
      playerId,
      isActive: true 
    },
  });

  if (!activeClub) {
    throw createError(404, "Player is not currently active in any club");
  }

  // Deactivate the player
  const deactivatedPlayer = await prisma.playerClub.update({
    where: { id: activeClub.id },
    data: {
      isActive: false,
      leftAt: new Date(),
      transferReason,
      approvedBy,
    },
    include: {
      player: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          uniqueIdNumber: true,
        },
      },
      club: {
        select: {
          id: true,
          clubName: true,
          city: true,
        },
      },
    },
  });

  res.json({
    message: "Player deactivated successfully",
    playerClub: deactivatedPlayer,
  });
});

// Get transfer statistics
const getTransferStats = asyncHandler(async (req, res) => {
  const stats = await prisma.$transaction(async (tx) => {
    const totalTransfers = await tx.playerClub.count();
    const activePlayers = await tx.playerClub.count({
      where: { isActive: true },
    });
    const inactivePlayers = await tx.playerClub.count({
      where: { isActive: false },
    });
    
    // Recent transfers (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const recentTransfers = await tx.playerClub.count({
      where: {
        joinedAt: {
          gte: thirtyDaysAgo,
        },
      },
    });

    return {
      totalTransfers,
      activePlayers,
      inactivePlayers,
      recentTransfers,
    };
  });

  res.json(stats);
});

module.exports = {
  getPlayerClubHistory,
  getClubPlayers,
  getPlayerActiveClub,
  requestPlayerTransfer,
  deactivatePlayer,
  getTransferStats,
};
