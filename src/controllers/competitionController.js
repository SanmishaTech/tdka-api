const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient();
const { z } = require("zod");
const createError = require("http-errors");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

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

const getCompetitions = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.max(1, parseInt(req.query.limit) || 10);
  const skip = (page - 1) * limit;

  const { search = "", sortBy = "competitionName", sortOrder = "asc" } = req.query;

  // Map frontend sort field "name" to database column "competitionName"
  const mappedSortBy = sortBy === "name" ? "competitionName" : sortBy;

  const where = {};

  // Filter by club based on user role
  if (req.user) {
    if (req.user.role === "clubadmin" && req.user.clubId) {
      // Club admins can only see competitions their club is participating in
      where.clubs = {
        some: {
          id: req.user.clubId
        }
      };
    } else if (req.user.role === "CLUB") {
      // Direct club login - find the associated club admin user's clubId
      const clubAdminUser = await prisma.user.findFirst({
        where: {
          email: req.user.email,
          role: "clubadmin"
        }
      });
      if (clubAdminUser && clubAdminUser.clubId) {
        where.clubs = {
          some: {
            id: clubAdminUser.clubId
          }
        };
      }
    }
    // Super admins and other roles can see all competitions (no club filter)
  }

  if (search) {
    where.OR = [
      { competitionName: { contains: search } },
      { age: { contains: search } },
    ];
  }

  const [competitions, total] = await Promise.all([
    prisma.competition.findMany({
      where,
      skip,
      take: limit,
      orderBy: { [mappedSortBy]: sortOrder },
      include: {
        groups: {
          select: {
            id: true,
            groupName: true,
            gender: true,
            age: true,
          },
        },
        clubs: {
          select: {
            id: true,
            clubName: true,
            affiliationNumber: true,
            city: true,
            mobile: true,
            email: true,
            region: {
              select: {
                regionName: true,
                taluka: {
                  select: {
                    talukaName: true
                  }
                }
              }
            }
          },
        },
      },
    }),
    prisma.competition.count({ where }),
  ]);

  // Format competitions for frontend compatibility
  const enhancedCompetitions = competitions.map(comp => {
    // Extract group IDs and club IDs for the frontend
    const groupIds = comp.groups.map(group => group.id.toString());
    const clubIds = comp.clubs.map(club => club.id.toString());
    
    return {
      id: comp.id,
      competitionName: comp.competitionName,
      maxPlayers: comp.maxPlayers,
      fromDate: comp.fromDate,
      toDate: comp.toDate,
      age: comp.age,
      lastEntryDate: comp.lastEntryDate,
      ageEligibilityDate: comp.ageEligibilityDate,
      rules: comp.rules,
      createdAt: comp.createdAt,
      updatedAt: comp.updatedAt,
      groups: groupIds,
      clubs: clubIds
    };
  });

  const totalPages = Math.ceil(total / limit);

  res.json({
    competitions: enhancedCompetitions,
    page,
    totalPages,
    totalCompetitions: total,
  });
});

const getCompetition = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) throw createError(400, "Invalid competition ID");

  // Build where clause with club filtering for club admins
  const where = { id };
  let userClubId = null;

  if (req.user) {
    if (req.user.role === "clubadmin" && req.user.clubId) {
      userClubId = req.user.clubId;
    } else if (req.user.role === "CLUB") {
      // Direct club login - find the associated club admin user's clubId
      const clubAdminUser = await prisma.user.findFirst({
        where: {
          email: req.user.email,
          role: "clubadmin"
        }
      });
      if (clubAdminUser && clubAdminUser.clubId) {
        userClubId = clubAdminUser.clubId;
      }
    }
  }

  const competition = await prisma.competition.findUnique({
    where,
    include: {
      groups: {
        select: {
          id: true,
          groupName: true,
          gender: true,
          age: true,
        },
      },
      clubs: {
        select: {
          id: true,
          clubName: true,
          affiliationNumber: true,
          city: true,
          mobile: true,
          email: true,
          region: {
            select: {
              regionName: true,
              taluka: {
                select: {
                  talukaName: true
                }
              }
            }
          }
        },
      },
    },
  });
  
  if (!competition) throw createError(404, "Competition not found");

  // Check if club admin has access to this competition
  if (userClubId) {
    const hasAccess = competition.clubs.some(club => club.id === userClubId);
    if (!hasAccess) {
      throw createError(403, "You don't have access to this competition");
    }
  }

  // Get registered players count for each club in this competition
  const clubsWithPlayerCount = await Promise.all(
    competition.clubs.map(async (club) => {
      const registeredPlayersCount = await prisma.competitionRegistration.count({
        where: {
          competitionId: id,
          clubId: club.id
        }
      });

      return {
        ...club,
        registeredPlayersCount
      };
    })
  );

  // Format the response for frontend compatibility
  const responseData = {
    id: competition.id,
    competitionName: competition.competitionName,
    maxPlayers: competition.maxPlayers,
    fromDate: competition.fromDate,
    toDate: competition.toDate,
    age: competition.age,
    lastEntryDate: competition.lastEntryDate,
    ageEligibilityDate: competition.ageEligibilityDate,
    rules: competition.rules,
    createdAt: competition.createdAt,
    updatedAt: competition.updatedAt,
    groups: competition.groups, // Return full group objects
    clubs: clubsWithPlayerCount  // Return clubs with player counts
  };

  res.json(responseData);
});

const createCompetition = asyncHandler(async (req, res) => {
  const schema = z.object({
    competitionName: z.string().min(1, "Competition name is required").max(255),
    maxPlayers: z.number().min(1, "Max players must be at least 1").max(1000, "Max players cannot exceed 1000"),
    fromDate: z.string().min(1, "From date is required").max(255),
    toDate: z.string().min(1, "To date is required").max(255),
    groups: z.array(z.string()).min(1, "At least one group must be selected"),
    clubs: z.array(z.string()).optional(),
    lastEntryDate: z.string().min(1, "Last entry date is required").max(255),
    ageEligibilityDate: z.string().min(1, "Age eligibility date is required").max(255).optional(),
    rules: z.string().optional(),
  });

  // Will throw Zod errors caught by asyncHandler
  const validatedData = await schema.parseAsync(req.body);

  // Extract groups and clubs for separate handling
  const { groups, clubs, ...competitionData } = validatedData;
  
  // For backward compatibility, store the first group's age as the competition age
  let age = "Multiple groups";
  
  if (groups && groups.length > 0) {
    // Try to get the first group's details if possible
    try {
      const firstGroup = await prisma.group.findFirst({
        where: { id: parseInt(groups[0]) },
        select: { age: true }
      });
      if (firstGroup) {
        age = firstGroup.age;
      }
    } catch (error) {
      console.error("Error fetching group details:", error);
    }
  }

  // Create the competition with the groups and clubs relationships
  const competition = await prisma.competition.create({ 
    data: {
      ...competitionData,
      age: age,
      groups: {
        connect: groups.map(groupId => ({ id: parseInt(groupId) }))
      },
      ...(clubs && clubs.length > 0 && {
        clubs: {
          connect: clubs.map(clubId => ({ id: parseInt(clubId) }))
        }
      })
    },
    include: {
      groups: true,
      clubs: true
    }
  });

  res.status(201).json(competition);
});

const updateCompetition = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) throw createError(400, "Invalid competition ID");

const schema = z
    .object({
      competitionName: z.string().min(1).max(255).optional(),
      maxPlayers: z.number().min(1, "Max players must be at least 1").max(1000, "Max players cannot exceed 1000").optional(),
      fromDate: z.string().min(1).max(255).optional(),
      toDate: z.string().min(1).max(255).optional(),
      groups: z.array(z.string()).min(1, "At least one group must be selected").optional(),
      clubs: z.array(z.string()).optional(),
      lastEntryDate: z.string().min(1).max(255).optional(),
      ageEligibilityDate: z.string().min(1).max(255).optional(),
      rules: z.string().optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: "At least one field is required",
    });

  const validatedData = await schema.parseAsync(req.body);

  const existing = await prisma.competition.findUnique({ 
    where: { id },
    include: { groups: true, clubs: true }
  });
  
  if (!existing) throw createError(404, "Competition not found");

  // Extract groups and clubs for separate handling if present
  const { groups, clubs, ...competitionData } = validatedData;
  
  // Update data object for Prisma
  const updateData = { ...competitionData };
  
  // Update age and groups if provided
  if (groups && groups.length > 0) {
    // For backward compatibility, store the first group's age as the competition age
    let age = "Multiple groups";
    
    try {
      const firstGroup = await prisma.group.findFirst({
        where: { id: parseInt(groups[0]) },
        select: { age: true }
      });
      if (firstGroup) {
        age = firstGroup.age;
      }
    } catch (error) {
      console.error("Error fetching group details:", error);
    }
    
    // Update age
    updateData.age = age;
    
    // Update groups relationship
    updateData.groups = {
      // Disconnect all existing groups
      set: [],
      // Connect the new groups
      connect: groups.map(groupId => ({ id: parseInt(groupId) }))
    };
  }

  // Update clubs relationship if provided
  if (clubs !== undefined) {
    updateData.clubs = {
      // Disconnect all existing clubs
      set: [],
      // Connect the new clubs if any
      ...(clubs.length > 0 && {
        connect: clubs.map(clubId => ({ id: parseInt(clubId) }))
      })
    };
  }

  const updated = await prisma.competition.update({
    where: { id },
    data: updateData,
    include: {
      groups: true,
      clubs: true
    }
  });

  res.json(updated);
});

const deleteCompetition = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) throw createError(400, "Invalid competition ID");

  const existing = await prisma.competition.findUnique({ where: { id } });
  if (!existing) throw createError(404, "Competition not found");

  await prisma.competition.delete({ where: { id } });
  res.json({ message: "Competition deleted successfully" });
});

// Get available competitions that a club can join
const getAvailableCompetitions = asyncHandler(async (req, res) => {
  let userClubId = null;

  if (req.user) {
    if (req.user.role === "clubadmin" && req.user.clubId) {
      userClubId = req.user.clubId;
    } else if (req.user.role === "CLUB") {
      // Direct club login - find the associated club admin user's clubId
      const clubAdminUser = await prisma.user.findFirst({
        where: {
          email: req.user.email,
          role: "clubadmin"
        }
      });
      if (clubAdminUser && clubAdminUser.clubId) {
        userClubId = clubAdminUser.clubId;
      }
    }
  }

  if (!userClubId) {
    return res.status(403).json({ errors: { message: "Access denied" } });
  }

  // Get competitions that the club is NOT already part of
  const availableCompetitions = await prisma.competition.findMany({
    where: {
      NOT: {
        clubs: {
          some: {
            id: userClubId
          }
        }
      }
    },
    include: {
      groups: {
        select: {
          id: true,
          groupName: true,
          gender: true,
          age: true,
        },
      },
      _count: {
        select: {
          clubs: true
        }
      }
    },
    orderBy: {
      competitionName: 'asc'
    }
  });

  res.json({
    competitions: availableCompetitions,
    totalCompetitions: availableCompetitions.length,
  });
});

// Join a competition
const joinCompetition = asyncHandler(async (req, res) => {
  const competitionId = parseInt(req.params.id);
  if (!competitionId) throw createError(400, "Invalid competition ID");

  let userClubId = null;

  if (req.user) {
    if (req.user.role === "clubadmin" && req.user.clubId) {
      userClubId = req.user.clubId;
    } else if (req.user.role === "CLUB") {
      // Direct club login - find the associated club admin user's clubId
      const clubAdminUser = await prisma.user.findFirst({
        where: {
          email: req.user.email,
          role: "clubadmin"
        }
      });
      if (clubAdminUser && clubAdminUser.clubId) {
        userClubId = clubAdminUser.clubId;
      }
    }
  }

  if (!userClubId) {
    return res.status(403).json({ errors: { message: "Access denied" } });
  }

  // Check if competition exists
  const competition = await prisma.competition.findUnique({
    where: { id: competitionId },
    include: {
      clubs: true
    }
  });

  if (!competition) throw createError(404, "Competition not found");

  // Check if club is already part of this competition
  const alreadyJoined = competition.clubs.some(club => club.id === userClubId);
  if (alreadyJoined) {
    throw createError(400, "Club is already part of this competition");
  }

  // Add club to competition
  const updatedCompetition = await prisma.competition.update({
    where: { id: competitionId },
    data: {
      clubs: {
        connect: { id: userClubId }
      }
    },
    include: {
      clubs: {
        select: {
          id: true,
          clubName: true,
          city: true,
        },
      },
    }
  });

  res.json({
    message: "Successfully joined the competition",
    competition: updatedCompetition
  });
});

// Leave a competition
const leaveCompetition = asyncHandler(async (req, res) => {
  const competitionId = parseInt(req.params.id);
  if (!competitionId) throw createError(400, "Invalid competition ID");

  let userClubId = null;

  if (req.user) {
    if (req.user.role === "clubadmin" && req.user.clubId) {
      userClubId = req.user.clubId;
    } else if (req.user.role === "CLUB") {
      // Direct club login - find the associated club admin user's clubId
      const clubAdminUser = await prisma.user.findFirst({
        where: {
          email: req.user.email,
          role: "clubadmin"
        }
      });
      if (clubAdminUser && clubAdminUser.clubId) {
        userClubId = clubAdminUser.clubId;
      }
    }
  }

  if (!userClubId) {
    return res.status(403).json({ errors: { message: "Access denied" } });
  }

  // Check if competition exists and club is part of it
  const competition = await prisma.competition.findUnique({
    where: { id: competitionId },
    include: {
      clubs: true
    }
  });

  if (!competition) throw createError(404, "Competition not found");

  // Check if club is part of this competition
  const isParticipating = competition.clubs.some(club => club.id === userClubId);
  if (!isParticipating) {
    throw createError(400, "Club is not part of this competition");
  }

  // Remove club from competition
  const updatedCompetition = await prisma.competition.update({
    where: { id: competitionId },
    data: {
      clubs: {
        disconnect: { id: userClubId }
      }
    },
    include: {
      clubs: {
        select: {
          id: true,
          clubName: true,
          city: true,
        },
      },
    }
  });

  res.json({
    message: "Successfully left the competition",
    competition: updatedCompetition
  });
});

// Get eligible players from club for a competition
const getEligiblePlayers = asyncHandler(async (req, res) => {
  const competitionId = parseInt(req.params.id);
  if (!competitionId) throw createError(400, "Invalid competition ID");

  let userClubId = null;

  if (req.user) {
    if (req.user.role === "clubadmin" && req.user.clubId) {
      userClubId = req.user.clubId;
    } else if (req.user.role === "CLUB") {
      // Direct club login - find the associated club admin user's clubId
      const clubAdminUser = await prisma.user.findFirst({
        where: {
          email: req.user.email,
          role: "clubadmin"
        }
      });
      if (clubAdminUser && clubAdminUser.clubId) {
        userClubId = clubAdminUser.clubId;
      }
    }
  }

  if (!userClubId) {
    return res.status(403).json({ errors: { message: "Access denied" } });
  }

  // Check if competition exists and club has access
  const competition = await prisma.competition.findUnique({
    where: { id: competitionId },
    include: {
      clubs: true
    }
  });

  if (!competition) throw createError(404, "Competition not found");

  // Check if club is part of this competition
  const hasAccess = competition.clubs.some(club => club.id === userClubId);
  if (!hasAccess) {
    throw createError(403, "Your club is not part of this competition");
  }

  // Get all players from the club
  const players = await prisma.player.findMany({
    where: {
      clubId: userClubId,
      isSuspended: false // Only active players
    },
    select: {
      id: true,
      uniqueIdNumber: true,
      firstName: true,
      lastName: true,
      dateOfBirth: true,
      position: true,
    },
    orderBy: [
      { firstName: 'asc' },
      { lastName: 'asc' }
    ]
  });

  res.json({
    players,
    totalPlayers: players.length,
  });
});

// Add players to competition
const addPlayersToCompetition = asyncHandler(async (req, res) => {
  const competitionId = parseInt(req.params.id);
  const { playerIds } = req.body;

  if (!competitionId) throw createError(400, "Invalid competition ID");
  if (!playerIds || !Array.isArray(playerIds) || playerIds.length === 0) {
    throw createError(400, "Player IDs are required");
  }

  let userClubId = null;

  if (req.user) {
    if (req.user.role === "clubadmin" && req.user.clubId) {
      userClubId = req.user.clubId;
    } else if (req.user.role === "CLUB") {
      // Direct club login - find the associated club admin user's clubId
      const clubAdminUser = await prisma.user.findFirst({
        where: {
          email: req.user.email,
          role: "clubadmin"
        }
      });
      if (clubAdminUser && clubAdminUser.clubId) {
        userClubId = clubAdminUser.clubId;
      }
    }
  }

  if (!userClubId) {
    return res.status(403).json({ errors: { message: "Access denied" } });
  }

  // Check if competition exists and club has access
  const competition = await prisma.competition.findUnique({
    where: { id: competitionId },
    include: {
      clubs: true
    }
  });

  if (!competition) throw createError(404, "Competition not found");

  // Check if club is part of this competition
  const hasAccess = competition.clubs.some(club => club.id === userClubId);
  if (!hasAccess) {
    throw createError(403, "Your club is not part of this competition");
  }

  // Validate max players limit
  if (playerIds.length > competition.maxPlayers) {
    throw createError(400, `Maximum ${competition.maxPlayers} players allowed`);
  }

  // Verify all players belong to the club
  const players = await prisma.player.findMany({
    where: {
      id: { in: playerIds.map(id => parseInt(id)) },
      clubId: userClubId,
      isSuspended: false
    }
  });

  if (players.length !== playerIds.length) {
    throw createError(400, "Some players are not valid or don't belong to your club");
  }

  // Create registration records for each player
  const registrationData = players.map(player => ({
    competitionId: competitionId,
    playerId: player.id,
    clubId: userClubId,
    registeredBy: req.user.email,
    status: 'registered'
  }));

  // Use transaction to ensure all registrations are created atomically
  const registrations = await prisma.$transaction(async (tx) => {
    // Check for existing registrations to avoid duplicates
    const existingRegistrations = await tx.competitionRegistration.findMany({
      where: {
        competitionId: competitionId,
        playerId: { in: playerIds.map(id => parseInt(id)) }
      }
    });

    const existingPlayerIds = existingRegistrations.map(reg => reg.playerId);
    const newRegistrations = registrationData.filter(reg => !existingPlayerIds.includes(reg.playerId));

    if (newRegistrations.length === 0) {
      throw createError(400, "All selected players are already registered for this competition");
    }

    // Create new registrations
    await tx.competitionRegistration.createMany({
      data: newRegistrations
    });

    // Fetch the created registrations with related data
    return await tx.competitionRegistration.findMany({
      where: {
        competitionId: competitionId,
        playerId: { in: newRegistrations.map(reg => reg.playerId) }
      },
      include: {
        player: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            uniqueIdNumber: true
          }
        },
        club: {
          select: {
            id: true,
            clubName: true
          }
        },
        competition: {
          select: {
            id: true,
            competitionName: true
          }
        }
      }
    });
  });

  res.json({
    message: `Successfully registered ${registrations.length} players for the competition`,
    registrations: registrations.map(reg => ({
      id: reg.id,
      registrationDate: reg.registrationDate,
      status: reg.status,
      player: {
        id: reg.player.id,
        name: `${reg.player.firstName} ${reg.player.lastName}`,
        uniqueIdNumber: reg.player.uniqueIdNumber
      },
      club: reg.club,
      competition: reg.competition
    }))
  });
});

// Get registered players for a competition (for club admins)
const getRegisteredPlayers = asyncHandler(async (req, res) => {
  const competitionId = parseInt(req.params.id);
  if (!competitionId) throw createError(400, "Invalid competition ID");

  let userClubId = null;

  if (req.user) {
    if (req.user.role === "clubadmin" && req.user.clubId) {
      userClubId = req.user.clubId;
    } else if (req.user.role === "CLUB") {
      // Direct club login - find the associated club admin user's clubId
      const clubAdminUser = await prisma.user.findFirst({
        where: {
          email: req.user.email,
          role: "clubadmin"
        }
      });
      if (clubAdminUser && clubAdminUser.clubId) {
        userClubId = clubAdminUser.clubId;
      }
    }
  }

  if (!userClubId) {
    return res.status(403).json({ errors: { message: "Access denied" } });
  }

  // Get registrations for this competition from the user's club
  const registrations = await prisma.competitionRegistration.findMany({
    where: {
      competitionId: competitionId,
      clubId: userClubId
    },
    include: {
      player: {
        select: {
          id: true,
          uniqueIdNumber: true,
          firstName: true,
          lastName: true,
          dateOfBirth: true,
          position: true,
        }
      },
      competition: {
        select: {
          id: true,
          competitionName: true,
          maxPlayers: true
        }
      }
    },
    orderBy: {
      registrationDate: 'desc'
    }
  });

  res.json({
    registrations: registrations.map(reg => ({
      id: reg.id,
      registrationDate: reg.registrationDate,
      status: reg.status,
      player: {
        id: reg.player.id,
        name: `${reg.player.firstName} ${reg.player.lastName}`,
        uniqueIdNumber: reg.player.uniqueIdNumber,
        position: reg.player.position,
        age: new Date().getFullYear() - new Date(reg.player.dateOfBirth).getFullYear()
      }
    })),
    totalRegistrations: registrations.length,
    competition: registrations[0]?.competition || null
  });
});

// Remove player from competition
const removePlayerFromCompetition = asyncHandler(async (req, res) => {
  const competitionId = parseInt(req.params.id);
  const playerId = parseInt(req.params.playerId);

  if (!competitionId || !playerId) {
    throw createError(400, "Invalid competition ID or player ID");
  }

  let userClubId = null;

  if (req.user) {
    if (req.user.role === "clubadmin" && req.user.clubId) {
      userClubId = req.user.clubId;
    } else if (req.user.role === "CLUB") {
      // Direct club login - find the associated club admin user's clubId
      const clubAdminUser = await prisma.user.findFirst({
        where: {
          email: req.user.email,
          role: "clubadmin"
        }
      });
      if (clubAdminUser && clubAdminUser.clubId) {
        userClubId = clubAdminUser.clubId;
      }
    }
  }

  if (!userClubId) {
    return res.status(403).json({ errors: { message: "Access denied" } });
  }

  // Find and delete the registration
  const registration = await prisma.competitionRegistration.findFirst({
    where: {
      competitionId: competitionId,
      playerId: playerId,
      clubId: userClubId
    },
    include: {
      player: {
        select: {
          firstName: true,
          lastName: true,
          uniqueIdNumber: true
        }
      }
    }
  });

  if (!registration) {
    throw createError(404, "Registration not found or you don't have permission to remove this player");
  }

  await prisma.competitionRegistration.delete({
    where: { id: registration.id }
  });

  res.json({
    message: `Successfully removed ${registration.player.firstName} ${registration.player.lastName} from the competition`,
    player: {
      id: playerId,
      name: `${registration.player.firstName} ${registration.player.lastName}`,
      uniqueIdNumber: registration.player.uniqueIdNumber
    }
  });
});

// Generate PDF for club details and players in a competition
const generateClubCompetitionPDF = asyncHandler(async (req, res) => {
  console.log('PDF generation endpoint hit');
  console.log('Params:', req.params);
  console.log('User:', req.user);
  
  const competitionId = parseInt(req.params.id);
  const clubId = parseInt(req.params.clubId);

  console.log('Competition ID:', competitionId, 'Club ID:', clubId);

  if (!competitionId || !clubId) {
    console.error('Invalid IDs provided');
    throw createError(400, "Invalid competition ID or club ID");
  }

  // Fetch competition details
  const competition = await prisma.competition.findUnique({
    where: { id: competitionId },
    select: {
      id: true,
      competitionName: true,
      fromDate: true,
      toDate: true,
      age: true,
      maxPlayers: true,
      lastEntryDate: true
    }
  });

  if (!competition) {
    throw createError(404, "Competition not found");
  }

  // Fetch club details
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    include: {
      region: {
        include: {
          taluka: true
        }
      }
    }
  });

  if (!club) {
    throw createError(404, "Club not found");
  }

  // Fetch registered players for this club in this competition
  const registrations = await prisma.competitionRegistration.findMany({
    where: {
      competitionId: competitionId,
      clubId: clubId
    },
    include: {
      player: {
        select: {
          id: true,
          uniqueIdNumber: true,
          firstName: true,
          middleName: true,
          lastName: true,
          dateOfBirth: true,
          position: true,
          mobile: true,
          aadharNumber: true,
          aadharVerified: true,
          profileImage: true
        }
      }
    },
    orderBy: {
      player: {
        firstName: 'asc'
      }
    }
  });

  // Create PDF document with better margins
  const doc = new PDFDocument({ 
    margin: 40,
    size: 'A4',
    info: {
      Title: `${club.clubName} - ${competition.competitionName} Registration Details`,
      Author: 'TDKA Competition Management System',
      Subject: 'Competition Registration Details',
      Keywords: 'competition, registration, players, club'
    }
  });
  
  // Set response headers for inline viewing
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${club.clubName}_${competition.competitionName}_Details.pdf"`);
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  // Pipe PDF to response
  doc.pipe(res);

  // Helper function to format date
  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    try {
      return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    } catch (error) {
      return dateString;
    }
  };

  // Helper function to calculate age
  const calculateAge = (dateOfBirth) => {
    if (!dateOfBirth) return 'N/A';
    const today = new Date();
    const birthDate = new Date(dateOfBirth);
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    return age;
  };

  // Colors
  const primaryColor = '#2563eb';
  const secondaryColor = '#64748b';
  const lightGray = '#f1f5f9';
  const darkGray = '#334155';

  // Header with logo area and title
  doc.rect(40, 40, doc.page.width - 80, 80).fill(primaryColor);
  
  // Title in header
  doc.fontSize(24).font('Helvetica-Bold').fillColor('white')
     .text('COMPETITION REGISTRATION DETAILS', 60, 70, { align: 'center' });
  
  // Reset position after header
  doc.y = 140;
  doc.fillColor('black');

  // Competition Information Section
  const sectionY = doc.y;
  doc.rect(40, sectionY, doc.page.width - 80, 25).fill(lightGray);
  doc.fontSize(16).font('Helvetica-Bold').fillColor(darkGray)
     .text('🏆 COMPETITION INFORMATION', 50, sectionY + 8);
  
  doc.y = sectionY + 35;
  doc.fillColor('black');
  
  // Competition details in a structured format
  const leftCol = 60;
  const rightCol = 320;
  const lineHeight = 18;
  
  doc.fontSize(11).font('Helvetica-Bold').text('Competition Name:', leftCol, doc.y);
  doc.font('Helvetica').text(competition.competitionName, leftCol + 120, doc.y);
  doc.y += lineHeight;
  
  doc.font('Helvetica-Bold').text('Competition Period:', leftCol, doc.y);
  doc.font('Helvetica').text(`${formatDate(competition.fromDate)} to ${formatDate(competition.toDate)}`, leftCol + 120, doc.y);
  doc.y += lineHeight;
  
  doc.font('Helvetica-Bold').text('Age Category:', leftCol, doc.y);
  doc.font('Helvetica').text(competition.age, leftCol + 120, doc.y);
  
  doc.font('Helvetica-Bold').text('Max Players:', rightCol, doc.y - lineHeight);
  doc.font('Helvetica').text(competition.maxPlayers.toString(), rightCol + 80, doc.y - lineHeight);
  
  doc.font('Helvetica-Bold').text('Last Entry Date:', rightCol, doc.y);
  doc.font('Helvetica').text(formatDate(competition.lastEntryDate), rightCol + 80, doc.y);
  
  doc.y += 25;

  // Club Information Section
  const clubSectionY = doc.y;
  doc.rect(40, clubSectionY, doc.page.width - 80, 25).fill(lightGray);
  doc.fontSize(16).font('Helvetica-Bold').fillColor(darkGray)
     .text('🏛️ CLUB INFORMATION', 50, clubSectionY + 8);
  
  doc.y = clubSectionY + 35;
  doc.fillColor('black');
  
  // Club details in structured format
  doc.fontSize(11).font('Helvetica-Bold').text('Club Name:', leftCol, doc.y);
  doc.font('Helvetica').text(club.clubName, leftCol + 120, doc.y);
  doc.y += lineHeight;
  
  doc.font('Helvetica-Bold').text('Affiliation Number:', leftCol, doc.y);
  doc.font('Helvetica').text(club.affiliationNumber, leftCol + 120, doc.y);
  
  doc.font('Helvetica-Bold').text('Contact:', rightCol, doc.y - lineHeight);
  doc.font('Helvetica').text(club.mobile, rightCol + 60, doc.y - lineHeight);
  
  doc.font('Helvetica-Bold').text('Email:', rightCol, doc.y);
  doc.font('Helvetica').text(club.email, rightCol + 60, doc.y);
  doc.y += lineHeight;
  
  doc.font('Helvetica-Bold').text('Location:', leftCol, doc.y);
  doc.font('Helvetica').text(`${club.city}, ${club.state}`, leftCol + 120, doc.y);
  doc.y += lineHeight;
  
  if (club.address) {
    doc.font('Helvetica-Bold').text('Address:', leftCol, doc.y);
    doc.font('Helvetica').text(club.address, leftCol + 120, doc.y, { width: 300 });
    doc.y += lineHeight;
  }
  
  if (club.region) {
    doc.font('Helvetica-Bold').text('Region:', leftCol, doc.y);
    doc.font('Helvetica').text(club.region.regionName, leftCol + 120, doc.y);
    if (club.region.taluka) {
      doc.font('Helvetica-Bold').text('Taluka:', rightCol, doc.y);
      doc.font('Helvetica').text(club.region.taluka.talukaName, rightCol + 60, doc.y);
    }
    doc.y += lineHeight;
  }
  
  doc.y += 15;

  // Players List Section
  const playersSectionY = doc.y;
  doc.rect(40, playersSectionY, doc.page.width - 80, 25).fill(lightGray);
  doc.fontSize(16).font('Helvetica-Bold').fillColor(darkGray)
     .text(`👥 REGISTERED PLAYERS (${registrations.length})`, 50, playersSectionY + 8);
  
  doc.y = playersSectionY + 35;
  doc.fillColor('black');

  if (registrations.length === 0) {
    // Empty state with better styling
    doc.rect(60, doc.y, doc.page.width - 120, 60).stroke('#e2e8f0');
    doc.fontSize(12).font('Helvetica').fillColor(secondaryColor)
       .text('No players registered for this competition yet.', 0, doc.y + 25, { align: 'center' });
    doc.fillColor('black');
  } else {
    // Enhanced table with better styling
    const tableStartY = doc.y;
    const rowHeight = 30;
    const headerHeight = 35;
    let currentY = tableStartY;

    // Table header background
    doc.rect(50, currentY, 500, headerHeight).fill(primaryColor);
    
    // Table headers with better spacing
    doc.fontSize(10).font('Helvetica-Bold').fillColor('white');
    const headers = [
      { text: 'Sr.', x: 60, width: 30 },
      { text: 'Player Name', x: 95, width: 130 },
      { text: 'Unique ID', x: 230, width: 90 },
      { text: 'Position', x: 325, width: 70 },
      { text: 'Age', x: 400, width: 35 },
      { text: 'Mobile', x: 440, width: 70 },
      { text: 'Status', x: 515, width: 50 }
    ];
    
    headers.forEach(header => {
      doc.text(header.text, header.x, currentY + 12, { width: header.width, align: 'center' });
    });

    currentY += headerHeight;
    doc.fillColor('black');

    // Draw player rows with alternating colors
    registrations.forEach((registration, index) => {
      const player = registration.player;
      const fullName = `${player.firstName} ${player.middleName ? player.middleName + ' ' : ''}${player.lastName}`;
      
      // Check if we need a new page
      if (currentY > 720) {
        doc.addPage();
        currentY = 50;
        
        // Redraw header on new page
        doc.rect(50, currentY, 500, headerHeight).fill(primaryColor);
        doc.fontSize(10).font('Helvetica-Bold').fillColor('white');
        headers.forEach(header => {
          doc.text(header.text, header.x, currentY + 12, { width: header.width, align: 'center' });
        });
        currentY += headerHeight;
        doc.fillColor('black');
      }

      // Alternating row colors
      if (index % 2 === 0) {
        doc.rect(50, currentY, 500, rowHeight).fill('#f8fafc');
      }

      // Row data
      doc.fontSize(9).font('Helvetica');
      const rowData = [
        { text: `${index + 1}`, x: 60, width: 30 },
        { text: fullName, x: 95, width: 130 },
        { text: player.uniqueIdNumber || 'N/A', x: 230, width: 90 },
        { text: player.position || 'N/A', x: 325, width: 70 },
        { text: calculateAge(player.dateOfBirth).toString(), x: 400, width: 35 },
        { text: player.mobile || 'N/A', x: 440, width: 70 },
        { text: player.aadharVerified ? '✓ Verified' : '⏳ Pending', x: 515, width: 50 }
      ];
      
      rowData.forEach(data => {
        const textColor = data.text.includes('✓') ? '#16a34a' : data.text.includes('⏳') ? '#ea580c' : 'black';
        doc.fillColor(textColor).text(data.text, data.x, currentY + 10, { 
          width: data.width, 
          align: data.x === 60 || data.x === 400 ? 'center' : 'left',
          ellipsis: true
        });
      });
      
      doc.fillColor('black');
      currentY += rowHeight;
    });

    // Table border
    doc.rect(50, tableStartY, 500, currentY - tableStartY).stroke('#e2e8f0');
    
    // Summary box
    doc.y = currentY + 20;
    doc.rect(50, doc.y, 200, 40).fill('#f0f9ff').stroke(primaryColor);
    doc.fontSize(11).font('Helvetica-Bold').fillColor(primaryColor)
       .text('SUMMARY', 60, doc.y + 8);
    doc.fontSize(10).font('Helvetica').fillColor('black')
       .text(`Total Players: ${registrations.length}`, 60, doc.y + 22);
    
    const verifiedCount = registrations.filter(reg => reg.player.aadharVerified).length;
    doc.text(`Verified: ${verifiedCount}`, 150, doc.y + 22);
  }

  // Footer with better styling
  const footerY = doc.page.height - 60;
  doc.rect(40, footerY, doc.page.width - 80, 40).fill('#f8fafc').stroke('#e2e8f0');
  
  doc.fontSize(8).font('Helvetica').fillColor(secondaryColor);
  doc.text('TDKA Competition Management System', 50, footerY + 8);
  doc.text(`Generated on: ${new Date().toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })}`, 50, footerY + 20);
  
  // Add page number
  doc.text(`Page 1`, doc.page.width - 100, footerY + 14, { align: 'right' });

  // Finalize PDF
  doc.end();
});

// Get registered players for a specific club in a specific competition
const getClubPlayersInCompetition = asyncHandler(async (req, res) => {
  const competitionId = parseInt(req.params.id);
  const clubId = parseInt(req.params.clubId);

  if (!competitionId || !clubId) {
    throw createError(400, "Invalid competition ID or club ID");
  }

  // Check if competition exists
  const competition = await prisma.competition.findUnique({
    where: { id: competitionId },
    select: {
      id: true,
      competitionName: true,
      maxPlayers: true
    }
  });

  if (!competition) {
    throw createError(404, "Competition not found");
  }

  // Check if club exists
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: {
      id: true,
      clubName: true
    }
  });

  if (!club) {
    throw createError(404, "Club not found");
  }

  // Get registrations for this club in this competition
  const registrations = await prisma.competitionRegistration.findMany({
    where: {
      competitionId: competitionId,
      clubId: clubId
    },
    include: {
      player: {
        select: {
          id: true,
          uniqueIdNumber: true,
          firstName: true,
          middleName: true,
          lastName: true,
          dateOfBirth: true,
          position: true,
          mobile: true,
          aadharVerified: true
        }
      }
    },
    orderBy: {
      registrationDate: 'desc'
    }
  });

  // Format the response
  const formattedRegistrations = registrations.map(reg => ({
    id: reg.id,
    registrationDate: reg.registrationDate,
    status: reg.status,
    player: {
      id: reg.player.id,
      name: `${reg.player.firstName} ${reg.player.middleName ? reg.player.middleName + ' ' : ''}${reg.player.lastName}`,
      uniqueIdNumber: reg.player.uniqueIdNumber,
      position: reg.player.position,
      mobile: reg.player.mobile,
      age: new Date().getFullYear() - new Date(reg.player.dateOfBirth).getFullYear(),
      aadharVerified: reg.player.aadharVerified
    }
  }));

  res.json({
    registrations: formattedRegistrations,
    totalRegistrations: formattedRegistrations.length,
    competition: competition,
    club: club
  });
});

module.exports = {
  getCompetitions,
  createCompetition,
  getCompetition,
  updateCompetition,
  deleteCompetition,
  getAvailableCompetitions,
  joinCompetition,
  leaveCompetition,
  getEligiblePlayers,
  addPlayersToCompetition,
  getRegisteredPlayers,
  removePlayerFromCompetition,
  generateClubCompetitionPDF,
  getClubPlayersInCompetition,
};