const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient();
const { z } = require("zod");
const createError = require("http-errors");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

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

// Helper: parse common date formats safely (YYYY-MM-DD, DD/MM/YYYY, or Date)
const parseEligibilityDate = (value) => {
  if (!value) return null;
  try {
    if (value instanceof Date) return isNaN(value) ? null : value;
    if (typeof value === 'string') {
      const s = value.trim();
      // ISO-like
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        const d = new Date(s);
        return isNaN(d) ? null : d;
      }
      // DD/MM/YYYY
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
        const [dd, mm, yyyy] = s.split('/').map((x) => parseInt(x, 10));
        const d = new Date(yyyy, mm - 1, dd);
        return isNaN(d) ? null : d;
      }
      // Fallback parse
      const d = new Date(s);
      return isNaN(d) ? null : d;
    }
  } catch (_) {
    return null;
  }
  return null;
};

// Helper: compute "Under X" label from an eligibility date (DOB cutoff)
const computeUnderAgeLabel = (eligibilityDate, asOf = new Date()) => {
  const dob = parseEligibilityDate(eligibilityDate);
  if (!dob) return null;
  let age = asOf.getFullYear() - dob.getFullYear();
  const m = asOf.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && asOf.getDate() < dob.getDate())) age--;
  if (!Number.isFinite(age) || age < 0) return null;
  return `Under ${age}`;
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
    } else if (req.user.role === "observer") {
      // Observers can only see the competition they are assigned to
      where.observerId = req.user.id;
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
            place: {
              select: {
                placeName: true,
                region: {
                  select: {
                    regionName: true
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

    // Prefer computed label from eligibility date if available
    const ageLabel = computeUnderAgeLabel(comp.ageEligibilityDate) || comp.age;
    
    return {
      id: comp.id,
      competitionName: comp.competitionName,
      maxPlayers: comp.maxPlayers,
      fromDate: comp.fromDate,
      toDate: comp.toDate,
      age: ageLabel,
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
          place: {
            select: {
              placeName: true,
              region: {
                select: {
                  regionName: true
                }
              }
            }
          }
        },
      },
    },
  });
  
  if (!competition) throw createError(404, "Competition not found");

  // Observers may only access their assigned competition
  if (req.user && req.user.role === 'observer') {
    if (competition.observerId !== req.user.id) {
      throw createError(403, "You don't have access to this competition");
    }
  }

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
    age: computeUnderAgeLabel(competition.ageEligibilityDate) || competition.age,
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
    maxPlayers: z
      .number()
      .min(10, "Minimum 10 players")
      .max(14, "Maximum 14 players"),
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
  
  // Prefer computing age label from eligibility date; fallback to first group's age
  let age = computeUnderAgeLabel(competitionData.ageEligibilityDate) || "Multiple groups";
  
  if (!age && groups && groups.length > 0) {
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
      maxPlayers: z
        .number()
        .min(10, "Minimum 10 players")
        .max(14, "Maximum 14 players")
        .optional(),
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

  // If an eligibility date is provided, prefer computing the age label from it
  const ageFromEligibility = computeUnderAgeLabel(competitionData.ageEligibilityDate);
  if (ageFromEligibility) {
    updateData.age = ageFromEligibility;
  }
  
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
    
    // Update age only if not already set from eligibility date
    if (!updateData.age) {
      updateData.age = age;
    }
    
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

    // Enforce max players when adding incrementally
    const currentCount = await tx.competitionRegistration.count({
      where: {
        competitionId: competitionId,
        clubId: userClubId,
      },
    });
    if (currentCount + newRegistrations.length > competition.maxPlayers) {
      const remaining = Math.max(0, competition.maxPlayers - currentCount);
      throw createError(400, remaining === 0
        ? `Maximum ${competition.maxPlayers} players already registered`
        : `You can register only ${remaining} more player(s). Maximum ${competition.maxPlayers} allowed`);
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
      ageEligibilityDate: true,
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
      place: {
        include: {
          region: true
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
     .text('COMPETITION INFORMATION', 50, sectionY + 8);
  
  doc.y = sectionY + 35;
  doc.fillColor('black');
  
  // Competition details in a structured format
  const leftCol = 60;
  const rightCol = 320;
  const lineHeight = 18;
  
  // Row: Competition Name
  let currentY = doc.y;
  doc.fontSize(11).font('Helvetica-Bold').text('Competition Name:', leftCol, currentY);
  doc.font('Helvetica').text(competition.competitionName, leftCol + 120, currentY);
  doc.y = currentY + lineHeight;
  
  // Row: Competition Period
  currentY = doc.y;
  doc.font('Helvetica-Bold').text('Competition Period:', leftCol, currentY);
  doc.font('Helvetica').text(`${formatDate(competition.fromDate)} to ${formatDate(competition.toDate)}`, leftCol + 120, currentY);
  doc.y = currentY + lineHeight;
  
  // Row: Eligibility Date (left) and Max Players (right)
  currentY = doc.y;
  doc.font('Helvetica-Bold').text('Eligibility Date:', leftCol, currentY);
  const eligibility = formatDate(competition.ageEligibilityDate);
  doc.font('Helvetica').text(eligibility, leftCol + 120, currentY);
  
  doc.font('Helvetica-Bold').text('Max Players:', rightCol, currentY);
  doc.font('Helvetica').text(competition.maxPlayers.toString(), rightCol + 80, currentY);
  doc.y = currentY + lineHeight;
  
  // Row: Last Entry Date (full row on right column baseline)
  currentY = doc.y;
  doc.font('Helvetica-Bold').text('Last Entry Date:', rightCol, currentY, { width: 100 });
  doc.font('Helvetica').text(formatDate(competition.lastEntryDate), rightCol + 100, currentY);
  
  doc.y += 25;

  // Club Information Section
  const clubSectionY = doc.y;
  doc.rect(40, clubSectionY, doc.page.width - 80, 25).fill(lightGray);
  doc.fontSize(16).font('Helvetica-Bold').fillColor(darkGray)
     .text('CLUB INFORMATION', 50, clubSectionY + 8);
  
  doc.y = clubSectionY + 35;
  doc.fillColor('black');
  // Build a clean location string (avoid undefined)
  const safeText = (v) => (v === null || v === undefined || v === '' ? null : v);
  const locationParts = [safeText(club.city), safeText(club.place?.placeName), safeText(club.place?.region?.regionName)];
  const location = locationParts.filter(Boolean).join(', ') || 'N/A';
  
  // Club details in a clean two-column grid
  const LBL_W = 120;
  const LEFT_VAL_W = 140;  // ensures no overlap with right column (leftCol + 120 + 140 = rightCol)
  const RIGHT_LBL_W = 80;
  const RIGHT_VAL_W = 140;
  const rowMinH = 18;
  const rowGap = 6;

  const textOpts = (w) => ({ width: w, lineGap: 1 });
  const measureH = (text, w) => {
    if (!text && text !== 0) return 0;
    return doc.font('Helvetica').fontSize(11).heightOfString(String(text), textOpts(w));
  };

  const renderInfoRow = (leftLabel, leftValue, rightLabel = null, rightValue = null) => {
    const startY = doc.y;
    const leftValText = leftValue ?? 'N/A';
    const rightValText = rightValue ?? 'N/A';
    const leftH = leftLabel ? measureH(leftValText, LEFT_VAL_W) : 0;
    const rightH = rightLabel ? measureH(rightValText, RIGHT_VAL_W) : 0;
    const rowH = Math.max(rowMinH, leftH, rightH);

    // Left column
    if (leftLabel) {
      doc.fontSize(11).font('Helvetica-Bold').text(leftLabel, leftCol, startY);
      doc.font('Helvetica').text(leftValText, leftCol + LBL_W, startY, textOpts(LEFT_VAL_W));
    }

    // Right column
    if (rightLabel) {
      doc.font('Helvetica-Bold').text(rightLabel, rightCol, startY);
      doc.font('Helvetica').text(rightValText, rightCol + RIGHT_LBL_W, startY, textOpts(RIGHT_VAL_W));
    }

    doc.y = startY + rowH + rowGap;
  };

  // Render rows
  renderInfoRow('Club Name:', club.clubName, 'Contact:', club.mobile);
  renderInfoRow('Affiliation Number:', club.affiliationNumber, 'Email:', club.email);
  renderInfoRow('Location:', location);
  if (club.address) {
    renderInfoRow('Address:', club.address);
  }
  if (club.place?.region) {
    renderInfoRow('Region:', club.place.region.regionName, 'Place:', club.place.placeName);
  }
  
  doc.y += 15;

  // Players List Section
  const renderPlayersHeader = () => {
    const headerY = doc.y;
    doc.rect(40, headerY, doc.page.width - 80, 25).fill(lightGray);
    doc.fontSize(16).font('Helvetica-Bold').fillColor(darkGray)
      .text(`REGISTERED PLAYERS (${registrations.length})`, 50, headerY + 8);
    doc.y = headerY + 35;
    doc.fillColor('black');
  };

  if (registrations.length === 0) {
    renderPlayersHeader();
    // Empty state with better styling
    doc.rect(60, doc.y, doc.page.width - 120, 60).stroke('#e2e8f0');
    doc.fontSize(12).font('Helvetica').fillColor(secondaryColor)
       .text('No players registered for this competition yet.', 0, doc.y + 25, { align: 'center' });
    doc.fillColor('black');
  } else {
    // Photo grid layout (4 columns)
    const cols = 4;
    const gridLeft = 50; // aligns with previous table left
    const gridWidth = 500; // fixed width used previously
    const colW = gridWidth / cols;
    const padding = 8;
    const photoSize = Math.min(colW - padding * 2, 110); // square photo area
    const nameBoxH = 24;
    const cellH = photoSize + nameBoxH + padding * 2;

    // Helper to safely resolve image path from stored relative path
    const resolveImagePath = (p) => {
      if (!p) return null;
      if (/^https?:\/\//i.test(p)) return null; // skip remote URLs for embedding
      if (path.isAbsolute(p)) return fs.existsSync(p) ? p : null;
      const abs = path.resolve(__dirname, '../../', p);
      return fs.existsSync(abs) ? abs : null;
    };

    // Ensure header appears on a page with enough room for at least one cell
    const footerSafeBottom = () => doc.page.height - 100; // keep clear of footer
    if (doc.y + 25 + 10 + cellH > footerSafeBottom()) {
      doc.addPage();
    }
    renderPlayersHeader();

    let startY = doc.y;
    let x = gridLeft;
    let y = startY;
    // footerSafeBottom already defined above

    registrations.forEach((reg, idx) => {
      const player = reg.player;
      const fullName = [player.firstName, player.middleName, player.lastName].filter(Boolean).join(' ').toUpperCase();

      // Move to next row every 'cols' items
      if (idx > 0 && idx % cols === 0) {
        x = gridLeft;
        y += cellH;
      }

      // Pagination check
      if (y + cellH > footerSafeBottom()) {
        doc.addPage();
        // Re-add section header on new page
        renderPlayersHeader();

        // Reset grid position for new page
        y = doc.y;
        x = gridLeft;
      }

      // Cell border
      doc.rect(x, y, colW, cellH).stroke('#94a3b8');

      // Photo frame
      const imgX = x + padding;
      const imgY = y + padding;
      doc.rect(imgX, imgY, photoSize, photoSize).stroke('#cbd5e1');

      const imgPath = resolveImagePath(player.profileImage);
      if (imgPath) {
        try {
          // Fit image within the square while preserving aspect ratio
          doc.image(imgPath, imgX, imgY, { fit: [photoSize, photoSize] });
        } catch (_) {
          // If image fails to load, fall back to placeholder
          doc.fontSize(8).fillColor(secondaryColor)
            .text('PHOTO ERROR', imgX, imgY + photoSize / 2 - 5, { width: photoSize, align: 'center' })
            .fillColor('black');
        }
      } else {
        // Placeholder when no image
        doc.fontSize(8).fillColor(secondaryColor)
          .text('NO PHOTO', imgX, imgY + photoSize / 2 - 5, { width: photoSize, align: 'center' })
          .fillColor('black');
      }

      // Name label
      doc.fontSize(9).font('Helvetica-Bold').fillColor('black')
        .text(fullName || 'UNKNOWN', x + 2, imgY + photoSize + 6, { width: colW - 4, align: 'center' });

      // Advance to next column
      x += colW;
    });

    // Signature/association area shown after the images (once, after grid)
    const signAreaHeight = 60;
    const minGapBelowGrid = 12; // ensure a small gap from the grid
    const footerTop = doc.page.height - 60; // footer rectangle starts here
    const bottomGap = 10; // gap above footer
    const desiredBottomY = footerTop - bottomGap - signAreaHeight; // sit just above footer
    let signY;
    if (desiredBottomY < y + cellH + minGapBelowGrid) {
      // Not enough room at the bottom under the grid; move to a fresh page
      doc.addPage();
      // Do NOT render players header here; this is not a new grid page
      signY = doc.y + 20;
    } else {
      // Anchor to bottom safely above footer
      signY = desiredBottomY;
    }
    // Layout constants for left/right alignment within content area
    const contentLeft = 50; // align with left content
    const contentWidth = doc.page.width - 100; // symmetric margins (50 each side)

    // Left-aligned small label
    doc.fontSize(10).font('Helvetica-Bold').fillColor('black')
      .text('seal of the association', contentLeft, signY, { width: contentWidth, align: 'left' });
    // Right-aligned role above association name
    doc.fontSize(10).font('Helvetica')
      .text('secretary', contentLeft, signY, { width: contentWidth, align: 'right' });
    // Association name under 'secretary' (right-aligned)
    doc.fontSize(11).font('Helvetica-Bold')
      .text('THANE JILHA KABADDI ASSOCIATION THANE GRAMIN', contentLeft, signY + 18, { width: contentWidth, align: 'right' });
  }
  // Summary removed per request

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
  
  // Page number removed (multi-page safe)

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

// Generate PDF listing all clubs participating in a competition
const generateCompetitionClubsPDF = asyncHandler(async (req, res) => {
  const competitionId = parseInt(req.params.id);
  if (!competitionId) {
    throw createError(400, "Invalid competition ID");
  }

  // Fetch competition with participating clubs
  const competition = await prisma.competition.findUnique({
    where: { id: competitionId },
    select: {
      id: true,
      competitionName: true,
      fromDate: true,
      toDate: true,
      age: true,
      ageEligibilityDate: true,
      lastEntryDate: true,
      clubs: {
        select: {
          id: true,
          clubName: true,
          affiliationNumber: true,
          city: true,
          place: {
            select: {
              placeName: true,
              region: { select: { regionName: true } }
            }
          },
        },
        orderBy: { clubName: 'asc' },
      },
    },
  });

  if (!competition) {
    throw createError(404, "Competition not found");
  }

  // Authorization: clubadmin/CLUB must belong to a club in this competition
  if (req.user) {
    let userClubId = null;
    if (req.user.role === 'clubadmin' && req.user.clubId) {
      userClubId = req.user.clubId;
    } else if (req.user.role === 'CLUB') {
      const clubAdminUser = await prisma.user.findFirst({
        where: { email: req.user.email, role: 'clubadmin' },
        select: { clubId: true },
      });
      if (clubAdminUser?.clubId) userClubId = clubAdminUser.clubId;
    }

    if (userClubId) {
      const allowed = competition.clubs.some((c) => c.id === userClubId);
      if (!allowed) {
        return res.status(403).json({ errors: { message: 'Access denied' } });
      }
    }
  }

  // Prepare PDF
  const doc = new PDFDocument({
    margin: 40,
    size: 'A4',
    info: {
      Title: `${competition.competitionName} - Participating Clubs`,
      Author: 'TDKA Competition Management System',
      Subject: 'Participating Clubs List',
    },
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${competition.competitionName}_Participating_Clubs.pdf"`);
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  doc.pipe(res);

  // Helpers
  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    try {
      return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });
    } catch (_) {
      return dateString;
    }
  };

  // Colors
  const primaryColor = '#2563eb';
  const secondaryColor = '#64748b';
  const lightGray = '#f1f5f9';
  const darkGray = '#334155';

  // Header
  doc.rect(40, 40, doc.page.width - 80, 80).fill(primaryColor);
  doc.fontSize(22).font('Helvetica-Bold').fillColor('white')
     .text('PARTICIPATING CLUBS', 60, 70, { align: 'center' });
  doc.y = 140;
  doc.fillColor('black');
  
  // Competition info
  const leftCol = 60;
  const rightCol = 320;
  const lineHeight = 18;
  doc.rect(40, doc.y, doc.page.width - 80, 25).fill(lightGray);
  doc.fontSize(16).font('Helvetica-Bold').fillColor(darkGray)
     .text(' COMPETITION INFORMATION', 50, doc.y + 8);
  doc.y += 35;
  doc.fillColor('black');
  
  // Row: Competition Name
  let rowY = doc.y;
  doc.fontSize(11).font('Helvetica-Bold').text('Competition Name:', leftCol, rowY);
  doc.font('Helvetica').text(competition.competitionName, leftCol + 130, rowY);
  doc.y = rowY + lineHeight;
  
  // Row: Competition Period
  rowY = doc.y;
  doc.font('Helvetica-Bold').text('Competition Period:', leftCol, rowY);
  doc.font('Helvetica').text(`${formatDate(competition.fromDate)} to ${formatDate(competition.toDate)}`, leftCol + 130, rowY);
  doc.y = rowY + lineHeight;
  
  // Row: Age Category (left) and Last Entry Date (right) on same line
  rowY = doc.y;
  doc.font('Helvetica-Bold').text('Age Category:', leftCol, rowY);
  const pdfAgeLabel = computeUnderAgeLabel(competition.ageEligibilityDate) || competition.age;
  doc.font('Helvetica').text(pdfAgeLabel, leftCol + 130, rowY);
  
  doc.font('Helvetica-Bold').text('Last Entry Date:', rightCol, rowY);
  doc.font('Helvetica').text(formatDate(competition.lastEntryDate), rightCol + 100, rowY);
  doc.y = rowY + lineHeight;

  doc.y += 25;

  // Clubs table section header
  doc.rect(40, doc.y, doc.page.width - 80, 25).fill(lightGray);
  doc.fontSize(16).font('Helvetica-Bold').fillColor(darkGray)
     .text(` PARTICIPATING CLUBS (${competition.clubs.length})`, 50, doc.y + 8);
  doc.y += 35;
  doc.fillColor('black');

  // Table
  const tableStartY = doc.y;
  const headerHeight = 30;
  const rowHeight = 24;
  let currentY = tableStartY;

  // Header background
  doc.rect(50, currentY, 500, headerHeight).fill(primaryColor);
  doc.fontSize(10).font('Helvetica-Bold').fillColor('white');
  const headers = [
    { text: 'Sr.', x: 60, width: 30 },
    { text: 'Club Name', x: 95, width: 180 },
    { text: 'Affiliation No.', x: 280, width: 100 },
    { text: 'City', x: 385, width: 70 },
    { text: 'Region', x: 460, width: 90 },
  ];
  headers.forEach(h => doc.text(h.text, h.x, currentY + 10, { width: h.width, align: 'center' }));
  currentY += headerHeight;
  doc.fillColor('black');

  // Rows
  const clubs = [...competition.clubs].sort((a,b) => a.clubName.localeCompare(b.clubName));
  if (clubs.length === 0) {
    doc.rect(60, currentY, doc.page.width - 120, 50).stroke('#e2e8f0');
    doc.fontSize(12).font('Helvetica').fillColor(secondaryColor)
       .text('No clubs have joined this competition yet.', 0, currentY + 18, { align: 'center' });
    doc.fillColor('black');
  } else {
    clubs.forEach((club, index) => {
      if (currentY > 720) {
        doc.addPage();
        currentY = 50;
        // Redraw header
        doc.rect(50, currentY, 500, headerHeight).fill(primaryColor);
        doc.fontSize(10).font('Helvetica-Bold').fillColor('white');
        headers.forEach(h => doc.text(h.text, h.x, currentY + 10, { width: h.width, align: 'center' }));
        currentY += headerHeight;
        doc.fillColor('black');
      }

      if (index % 2 === 0) {
        doc.rect(50, currentY, 500, rowHeight).fill('#f8fafc');
      }

      doc.fontSize(9).font('Helvetica').fillColor('black');
      const row = [
        { text: `${index + 1}`, x: 60, width: 30, align: 'center' },
        { text: club.clubName || 'N/A', x: 95, width: 180 },
        { text: club.affiliationNumber || 'N/A', x: 280, width: 100 },
        { text: club.city || 'N/A', x: 385, width: 70 },
        { text: club.place?.region?.regionName || 'N/A', x: 460, width: 90 },
      ];
      row.forEach(col => {
        doc.text(col.text, col.x, currentY + 8, { width: col.width, align: (col.align || 'left') });
      });
      currentY += rowHeight;
    });

    // Table border
    doc.rect(50, tableStartY, 500, currentY - tableStartY).stroke('#e2e8f0');
  }

  // Footer
  const footerY = doc.page.height - 60;
  doc.rect(40, footerY, doc.page.width - 80, 40).fill('#f8fafc').stroke('#e2e8f0');
  doc.fontSize(8).font('Helvetica').fillColor(secondaryColor);
  doc.text('TDKA Competition Management System', 50, footerY + 8);
  doc.text(`Generated on: ${new Date().toLocaleString('en-US', { year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit' })}`, 50, footerY + 20);

  doc.end();
});

// Create and assign an observer (one per competition)
const setObserverForCompetition = asyncHandler(async (req, res) => {
  const competitionId = parseInt(req.params.id);
  if (!competitionId) throw createError(400, "Invalid competition ID");

  // Only admins can set observers (frontend already restricts, but enforce on backend too)
  if (!req.user || req.user.role !== 'admin') {
    throw createError(403, "Access denied");
  }

  const schema = z.object({
    email: z.string().email("Invalid email address"),
    password: z.string().min(6, "Password must be at least 6 characters long"),
  });

  const { email, password } = await schema.parseAsync(req.body);

  // Ensure competition exists and doesn't already have an observer
  const competition = await prisma.competition.findUnique({
    where: { id: competitionId },
    select: { id: true, competitionName: true, observerId: true }
  });

  if (!competition) throw createError(404, "Competition not found");
  if (competition.observerId) {
    throw createError(400, "An observer is already assigned to this competition");
  }

  // Ensure user with this email doesn't already exist (email is unique)
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    throw createError(400, `User with email ${email} already exists`);
  }

  // Create observer user
  const hashedPassword = await bcrypt.hash(password, 10);
  const observerName = `Observer - ${competition.competitionName}`;

  const observer = await prisma.user.create({
    data: {
      name: observerName,
      email,
      password: hashedPassword,
      role: 'observer',
      active: true,
    },
    select: { id: true, name: true, email: true, role: true }
  });

  // Assign to competition
  await prisma.competition.update({
    where: { id: competitionId },
    data: { observerId: observer.id }
  });

  res.status(201).json({
    message: "Observer created and assigned successfully",
    observer,
    competition: { id: competition.id, competitionName: competition.competitionName }
  });
});

// Get current observer for a competition
const getObserverForCompetition = asyncHandler(async (req, res) => {
  const competitionId = parseInt(req.params.id);
  if (!competitionId) throw createError(400, "Invalid competition ID");

  if (!req.user || req.user.role !== 'admin') {
    throw createError(403, "Access denied");
  }

  const competition = await prisma.competition.findUnique({
    where: { id: competitionId },
    select: {
      id: true,
      competitionName: true,
      observer: { select: { id: true, name: true, email: true, role: true } },
    },
  });

  if (!competition) throw createError(404, "Competition not found");
  if (!competition.observer) throw createError(404, "No observer assigned");

  res.json({ observer: competition.observer, competition: { id: competition.id, competitionName: competition.competitionName } });
});

// Update existing observer (email and/or password)
const updateObserverForCompetition = asyncHandler(async (req, res) => {
  const competitionId = parseInt(req.params.id);
  if (!competitionId) throw createError(400, "Invalid competition ID");

  if (!req.user || req.user.role !== 'admin') {
    throw createError(403, "Access denied");
  }

  const schema = z.object({
    email: z.string().email("Invalid email address").optional(),
    password: z.string().min(6, "Password must be at least 6 characters long").optional(),
  }).refine((data) => data.email || data.password, { message: 'At least one field (email or password) must be provided' });

  const { email, password } = await schema.parseAsync(req.body);

  const competition = await prisma.competition.findUnique({
    where: { id: competitionId },
    select: { observerId: true },
  });

  if (!competition) throw createError(404, 'Competition not found');
  if (!competition.observerId) throw createError(404, 'No observer assigned');

  const updateData = {};
  if (email) {
    // Ensure the new email is not already used by another user
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && existing.id !== competition.observerId) {
      throw createError(400, `User with email ${email} already exists`);
    }
    updateData.email = email;
  }
  if (password) {
    updateData.password = await bcrypt.hash(password, 10);
  }

  const updatedObserver = await prisma.user.update({
    where: { id: competition.observerId },
    data: updateData,
    select: { id: true, name: true, email: true, role: true },
  });

  res.json({ message: 'Observer updated successfully', observer: updatedObserver });
});

// Create and assign a referee (one per competition)
const setRefereeForCompetition = asyncHandler(async (req, res) => {
  const competitionId = parseInt(req.params.id);
  if (!competitionId) throw createError(400, "Invalid competition ID");

  // Only admins can set referees
  if (!req.user || req.user.role !== 'admin') {
    throw createError(403, "Access denied");
  }

  const schema = z.object({
    email: z.string().email("Invalid email address"),
    password: z.string().min(6, "Password must be at least 6 characters long"),
  });

  const { email, password } = await schema.parseAsync(req.body);

  // Ensure competition exists and doesn't already have a referee
  const competition = await prisma.competition.findUnique({
    where: { id: competitionId },
    select: { id: true, competitionName: true, refereeId: true }
  });

  if (!competition) throw createError(404, "Competition not found");
  if (competition.refereeId) {
    throw createError(400, "A referee is already assigned to this competition");
  }

  // Ensure user with this email doesn't already exist
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw createError(400, `User with email ${email} already exists`);
  }

  // Create referee user
  const hashedPassword = await bcrypt.hash(password, 10);
  const refereeName = `Referee - ${competition.competitionName}`;

  const referee = await prisma.user.create({
    data: {
      name: refereeName,
      email,
      password: hashedPassword,
      role: 'referee',
      active: true,
    },
    select: { id: true, name: true, email: true, role: true }
  });

  // Assign to competition
  await prisma.competition.update({
    where: { id: competitionId },
    data: { refereeId: referee.id }
  });

  res.status(201).json({
    message: "Referee created and assigned successfully",
    referee,
    competition: { id: competition.id, competitionName: competition.competitionName }
  });
});

// Get current referee for a competition
const getRefereeForCompetition = asyncHandler(async (req, res) => {
  const competitionId = parseInt(req.params.id);
  if (!competitionId) throw createError(400, "Invalid competition ID");

  if (!req.user || req.user.role !== 'admin') {
    throw createError(403, "Access denied");
  }

  const competition = await prisma.competition.findUnique({
    where: { id: competitionId },
    select: {
      id: true,
      competitionName: true,
      referee: { select: { id: true, name: true, email: true, role: true } },
    },
  });

  if (!competition) throw createError(404, "Competition not found");
  if (!competition.referee) throw createError(404, "No referee assigned");

  res.json({ referee: competition.referee, competition: { id: competition.id, competitionName: competition.competitionName } });
});

// Update existing referee (email and/or password)
const updateRefereeForCompetition = asyncHandler(async (req, res) => {
  const competitionId = parseInt(req.params.id);
  if (!competitionId) throw createError(400, "Invalid competition ID");

  if (!req.user || req.user.role !== 'admin') {
    throw createError(403, "Access denied");
  }

  const schema = z.object({
    email: z.string().email("Invalid email address").optional(),
    password: z.string().min(6, "Password must be at least 6 characters long").optional(),
  }).refine((data) => data.email || data.password, { message: 'At least one field (email or password) must be provided' });

  const { email, password } = await schema.parseAsync(req.body);

  const competition = await prisma.competition.findUnique({
    where: { id: competitionId },
    select: { refereeId: true },
  });

  if (!competition) throw createError(404, 'Competition not found');
  if (!competition.refereeId) throw createError(404, 'No referee assigned');

  const updateData = {};
  if (email) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && existing.id !== competition.refereeId) {
      throw createError(400, `User with email ${email} already exists`);
    }
    updateData.email = email;
  }
  if (password) {
    updateData.password = await bcrypt.hash(password, 10);
  }

  const updatedReferee = await prisma.user.update({
    where: { id: competition.refereeId },
    data: updateData,
    select: { id: true, name: true, email: true, role: true },
  });

  res.json({ message: 'Referee updated successfully', referee: updatedReferee });
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
  generateCompetitionClubsPDF,
  getClubPlayersInCompetition,
  getObserverForCompetition,
  updateObserverForCompetition,
  setObserverForCompetition,
  // Referee management
  setRefereeForCompetition,
  getRefereeForCompetition,
  updateRefereeForCompetition,
};
