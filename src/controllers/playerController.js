const { PrismaClient } = require("@prisma/client");
const asyncHandler = require("express-async-handler");
const createError = require("http-errors");
const ExcelJS = require("exceljs");

const prisma = new PrismaClient();

// Get all players with pagination and filtering
const getPlayers = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    search = "",
    isSuspended,
    aadharVerified,
    sortBy = "id",
    sortOrder = "asc",
    export: exportData = false,
  } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  // Build where clause
  const where = {};
  
  // Filter by club based on user role
  if (req.user) {
    if (req.user.role === "clubadmin" && req.user.clubId) {
      // Club admins can only see players from their club
      where.clubId = req.user.clubId;
    } else if (req.user.role === "CLUB") {
      // Direct club login - find the associated club admin user's clubId
      const clubAdminUser = await prisma.user.findFirst({
        where: {
          email: req.user.email,
          role: "clubadmin"
        }
      });
      if (clubAdminUser && clubAdminUser.clubId) {
        where.clubId = clubAdminUser.clubId;
      }
    }
    // Super admins and other roles can see all players (no clubId filter)
  }
  
  if (search) {
    where.OR = [
      { firstName: { contains: search } },
      { lastName: { contains: search } },
      { uniqueIdNumber: { contains: search } },
      { aadharNumber: { contains: search } },
    ];
  }

  if (isSuspended !== undefined) {
    where.isSuspended = isSuspended === "true";
  }

  if (aadharVerified !== undefined) {
    where.aadharVerified = aadharVerified === "true";
  }

  const orderBy = { [sortBy]: sortOrder };

  if (exportData === "true") {
    // Export all players to Excel
    const players = await prisma.player.findMany({
      where,
      include: {
        groups: true,
        club: true,
      },
      orderBy,
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Players");

    worksheet.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Unique ID", key: "uniqueIdNumber", width: 15 },
      { header: "First Name", key: "firstName", width: 15 },
      { header: "Middle Name", key: "middleName", width: 15 },
      { header: "Last Name", key: "lastName", width: 15 },
      { header: "Date of Birth", key: "dateOfBirth", width: 15 },
      { header: "Position", key: "position", width: 15 },
      { header: "Address", key: "address", width: 30 },
      { header: "Mobile", key: "mobile", width: 15 },
      { header: "Aadhar Number", key: "aadharNumber", width: 15 },
      { header: "Club", key: "club", width: 20 },
      { header: "Aadhar Verified", key: "aadharVerified", width: 15 },
      { header: "Suspended", key: "isSuspended", width: 15 },
    ];

    players.forEach((player) => {
      worksheet.addRow({
        ...player,
        club: player.club?.clubName || "No Club",
        dateOfBirth: player.dateOfBirth.toISOString().split("T")[0],
      });
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", "attachment; filename=players.xlsx");

    await workbook.xlsx.write(res);
    res.end();
    return;
  }

  const [players, totalPlayers] = await Promise.all([
    prisma.player.findMany({
      where,
      include: {
        groups: true,
        club: true,
      },
      orderBy,
      skip,
      take,
    }),
    prisma.player.count({ where }),
  ]);

  const totalPages = Math.ceil(totalPlayers / take);

  res.json({
    players,
    page: parseInt(page),
    totalPages,
    totalPlayers,
  });
});

// Get player by ID
const getPlayerById = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.id);
  if (!playerId) throw createError(400, "Invalid player ID");

  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: {
      groups: true,
      club: {
        include: {
          region: {
            include: {
              taluka: true
            }
          }
        }
      }
    },
  });

  if (!player) throw createError(404, "Player not found");

  res.json(player);
});

// Create new player
const createPlayer = asyncHandler(async (req, res) => {
  const {
    firstName,
    middleName,
    lastName,
    motherName,
    dateOfBirth,
    position,
    address,
    mobile,
    aadharNumber,
    clubId,
    groupIds,
  } = req.body;

  // Determine the clubId to use
  let finalClubId = null;
  
  if (req.user) {
    // If user is a club admin and has a clubId, use it
    if (req.user.role === "clubadmin" && req.user.clubId) {
      finalClubId = req.user.clubId;
    }
    // If user is a club (direct club login), find the associated user's clubId
    else if (req.user.role === "CLUB") {
      // Find the club admin user associated with this club
      const clubAdminUser = await prisma.user.findFirst({
        where: {
          email: req.user.email,
          role: "clubadmin"
        }
      });
      if (clubAdminUser && clubAdminUser.clubId) {
        finalClubId = clubAdminUser.clubId;
      }
    }
    // For other roles (like super admin), use the provided clubId
    else if (clubId) {
      finalClubId = parseInt(clubId);
    }
  } else if (clubId) {
    // Fallback to provided clubId if no user context
    finalClubId = parseInt(clubId);
  }

  // Generate unique ID number based on club
  let uniqueIdNumber;
  
  if (finalClubId) {
    // Get club details to extract the club number from uniqueNumber
    const club = await prisma.club.findUnique({
      where: { id: finalClubId },
      select: { uniqueNumber: true }
    });
    
    if (!club) {
      throw createError(400, "Club not found");
    }
    
    // Extract club number from club's uniqueNumber (e.g., "TDKA/SAD/TDKA01" -> "TDKA01")
    const clubNumberMatch = club.uniqueNumber.match(/(TDKA\d+)$/);
    const clubNumber = clubNumberMatch ? clubNumberMatch[1] : "TDKA00";
    
    // Count existing players for this club to generate sequential number
    const clubPlayerCount = await prisma.player.count({
      where: { clubId: finalClubId }
    });
    
    const playerSequence = String(clubPlayerCount + 1).padStart(10, "0");
    uniqueIdNumber = `TDKA/${clubNumber}/${playerSequence}`;
  } else {
    // Fallback for players without clubs
    const totalPlayerCount = await prisma.player.count();
    const playerSequence = String(totalPlayerCount + 1).padStart(10, "0");
    uniqueIdNumber = `TDKA/TDKA00/${playerSequence}`;
  }

  const playerData = {
    uniqueIdNumber,
    firstName,
    middleName,
    lastName,
    motherName,
    dateOfBirth: new Date(dateOfBirth),
    position,
    address,
    mobile,
    aadharNumber,
    clubId: finalClubId,
  };

  if (req.files?.profileImage) {
    playerData.profileImage = req.files.profileImage[0].path;
  }

  try {
    const player = await prisma.player.create({
      data: {
        ...playerData,
        groups: groupIds
          ? {
              connect: (() => {
                try {
                  const parsedGroupIds = Array.isArray(groupIds) ? groupIds : JSON.parse(groupIds);
                  return parsedGroupIds.map((id) => ({ id: parseInt(id) }));
                } catch (error) {
                  console.error('Error parsing groupIds:', error);
                  throw createError(400, 'Invalid groupIds format');
                }
              })(),
            }
          : undefined,
      },
      include: {
        groups: true,
        club: true,
      },
    });

    res.status(201).json(player);
  } catch (error) {
    // Handle Prisma unique constraint errors
    if (error.code === 'P2002') {
      const field = error.meta?.target?.[0];
      let message = 'A player with this information already exists.';
      
      if (field === 'aadharNumber') {
        message = 'A player with this Aadhar number already exists. Please check the Aadhar number and try again.';
      } else if (field === 'mobile') {
        message = 'A player with this mobile number already exists. Please check the mobile number and try again.';
      } else if (field === 'uniqueIdNumber') {
        message = 'A player with this unique ID already exists. Please try again.';
      }
      
      throw createError(409, message);
    }
    
    // Re-throw other errors
    throw error;
  }
});

// Update player
const updatePlayer = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.id);
  if (!playerId) throw createError(400, "Invalid player ID");

  const {
    firstName,
    middleName,
    lastName,
    motherName,
    dateOfBirth,
    position,
    address,
    mobile,
    aadharNumber,
    aadharVerified,
    clubId,
    groupIds,
  } = req.body;

  // Determine the clubId to use for updates
  let finalClubId = undefined; // Use undefined to not update if not specified
  
  if (clubId !== undefined) {
    if (req.user) {
      // If user is a club admin, they can only assign to their own club or remove (null)
      if (req.user.role === "clubadmin" && req.user.clubId) {
        if (clubId === null || clubId === "" || parseInt(clubId) === req.user.clubId) {
          finalClubId = clubId ? parseInt(clubId) : null;
        } else {
          throw createError(403, "Club admins can only assign players to their own club");
        }
      }
      // If user is a club (direct club login), find the associated user's clubId
      else if (req.user.role === "CLUB") {
        const clubAdminUser = await prisma.user.findFirst({
          where: {
            email: req.user.email,
            role: "clubadmin"
          }
        });
        if (clubAdminUser && clubAdminUser.clubId) {
          if (clubId === null || clubId === "" || parseInt(clubId) === clubAdminUser.clubId) {
            finalClubId = clubId ? parseInt(clubId) : null;
          } else {
            throw createError(403, "Club admins can only assign players to their own club");
          }
        }
      }
      // For other roles (like super admin), use the provided clubId
      else {
        finalClubId = clubId ? parseInt(clubId) : null;
      }
    } else {
      // Fallback to provided clubId if no user context
      finalClubId = clubId ? parseInt(clubId) : null;
    }
  }

  const updateData = {
    firstName,
    middleName,
    lastName,
    motherName,
    dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
    position,
    address,
    mobile,
    aadharNumber,
    aadharVerified: aadharVerified !== undefined ? aadharVerified === "true" : undefined,
    clubId: finalClubId,
  };

  // Remove undefined values
  Object.keys(updateData).forEach(
    (key) => updateData[key] === undefined && delete updateData[key]
  );

  if (req.files?.profileImage) {
    updateData.profileImage = req.files.profileImage[0].path;
  }

  try {
    const player = await prisma.player.update({
      where: { id: playerId },
      data: {
        ...updateData,
        groups: groupIds
          ? {
              set: (() => {
                try {
                  const parsedGroupIds = Array.isArray(groupIds) ? groupIds : JSON.parse(groupIds);
                  return parsedGroupIds.map((id) => ({ id: parseInt(id) }));
                } catch (error) {
                  console.error('Error parsing groupIds:', error);
                  throw createError(400, 'Invalid groupIds format');
                }
              })(),
            }
          : undefined,
      },
      include: {
        groups: true,
        club: true,
      },
    });

    res.json(player);
  } catch (error) {
    // Handle Prisma unique constraint errors
    if (error.code === 'P2002') {
      const field = error.meta?.target?.[0];
      let message = 'A player with this information already exists.';
      
      if (field === 'aadharNumber') {
        message = 'A player with this Aadhar number already exists. Please check the Aadhar number and try again.';
      } else if (field === 'mobile') {
        message = 'A player with this mobile number already exists. Please check the mobile number and try again.';
      } else if (field === 'uniqueIdNumber') {
        message = 'A player with this unique ID already exists. Please try again.';
      }
      
      throw createError(409, message);
    }
    
    // Handle record not found errors
    if (error.code === 'P2025') {
      throw createError(404, 'Player not found');
    }
    
    // Re-throw other errors
    throw error;
  }
});

// Toggle suspension status
const toggleSuspension = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.id);
  if (!playerId) throw createError(400, "Invalid player ID");

  const { isSuspended } = req.body;

  const player = await prisma.player.update({
    where: { id: playerId },
    data: { isSuspended },
    include: {
      groups: true,
      club: true,
    },
  });

  res.json(player);
});

// Toggle Aadhar verification status
const toggleAadharVerification = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.id);
  if (!playerId) throw createError(400, "Invalid player ID");

  const { aadharVerified } = req.body;

  const player = await prisma.player.update({
    where: { id: playerId },
    data: { aadharVerified },
    include: {
      groups: true,
      club: true,
    },
  });

  res.json(player);
});

// Get player's current club
const getPlayerClub = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.playerId);
  if (!playerId) throw createError(400, "Invalid player ID");

  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: {
      club: {
        include: {
          region: {
            include: {
              taluka: true
            }
          }
        }
      }
    }
  });

  if (!player) throw createError(404, "Player not found");

  res.json({
    player: {
      id: player.id,
      name: `${player.firstName} ${player.lastName}`,
      club: player.club
    }
  });
});

// Get all players for a specific club
const getClubPlayers = asyncHandler(async (req, res) => {
  const clubId = parseInt(req.params.clubId);
  if (!clubId) throw createError(400, "Invalid club ID");

  const players = await prisma.player.findMany({
    where: { clubId },
    include: {
      groups: true
    },
    orderBy: [
      { firstName: 'asc' },
      { lastName: 'asc' }
    ]
  });

  res.json(players);
});

// Transfer player to a new club
const transferPlayer = asyncHandler(async (req, res) => {
  const { playerId, newClubId, transferReason } = req.body;

  if (!playerId || !newClubId) {
    throw createError(400, "Player ID and new club ID are required");
  }

  // Check if player exists
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: { club: true }
  });

  if (!player) throw createError(404, "Player not found");

  // Check if new club exists
  const newClub = await prisma.club.findUnique({
    where: { id: newClubId }
  });

  if (!newClub) throw createError(404, "New club not found");

  // Update player's club
  const updatedPlayer = await prisma.player.update({
    where: { id: playerId },
    data: { clubId: newClubId },
    include: {
      club: true
    }
  });

  res.status(200).json({
    message: "Player transfer completed successfully",
    player: updatedPlayer,
    previousClub: player.club,
    newClub: newClub
  });
});

// Remove player from club
const removePlayerFromClub = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.playerId);
  if (!playerId) throw createError(400, "Invalid player ID");

  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: { club: true }
  });

  if (!player) throw createError(404, "Player not found");
  if (!player.clubId) throw createError(400, "Player is not associated with any club");

  const updatedPlayer = await prisma.player.update({
    where: { id: playerId },
    data: { clubId: null }
  });

  res.json({
    message: "Player removed from club successfully",
    player: updatedPlayer,
    previousClub: player.club
  });
});

// Get club statistics
const getClubStats = asyncHandler(async (req, res) => {
  const stats = await prisma.$transaction(async (tx) => {
    const totalPlayers = await tx.player.count();
    const playersWithClubs = await tx.player.count({
      where: { clubId: { not: null } }
    });
    const playersWithoutClubs = totalPlayers - playersWithClubs;

    const clubsWithPlayers = await tx.club.findMany({
      include: {
        _count: {
          select: { players: true }
        }
      },
      orderBy: {
        players: {
          _count: 'desc'
        }
      }
    });

    return {
      totalPlayers,
      playersWithClubs,
      playersWithoutClubs,
      totalClubs: clubsWithPlayers.length,
      clubsWithPlayers: clubsWithPlayers.filter(club => club._count.players > 0).length,
      topClubsByPlayerCount: clubsWithPlayers.slice(0, 5).map(club => ({
        clubName: club.clubName,
        playerCount: club._count.players
      }))
    };
  });

  res.json(stats);
});

module.exports = {
  getPlayers,
  getPlayerById,
  createPlayer,
  updatePlayer,
  toggleSuspension,
  toggleAadharVerification,
  getPlayerClub,
  getClubPlayers,
  transferPlayer,
  removePlayerFromClub,
  getClubStats
};