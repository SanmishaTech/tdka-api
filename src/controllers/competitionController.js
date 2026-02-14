const { Prisma } = require("@prisma/client");
const prisma = require("../config/db");
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

// Helper: calculate age on a reference date (defaults to today)
const calculateAgeOn = (dob, refDate = new Date()) => {
  if (!dob) return null;
  const birth = dob instanceof Date ? dob : new Date(dob);
  if (isNaN(birth)) return null;
  const ref = refDate instanceof Date ? refDate : new Date(refDate);
  if (isNaN(ref)) return null;
  let age = ref.getFullYear() - birth.getFullYear();
  const m = ref.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < birth.getDate())) age--;
  return age;
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
    } else if (req.user.role === "referee") {
      // Referees can only see competitions they are assigned to
      where.refereeId = req.user.id;
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
      // Join with CompetitionGroup to get the specific age eligibility date for each group
      include: {
        groups: {
          include: {
            group: {
              select: {
                id: true,
                groupName: true,
                gender: true,
                age: true,
                ageType: true,
                createdAt: true,
                updatedAt: true
              }
            }
          }
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
    // Extract group details and club IDs for the frontend
    // We now have to map from the Join table (CompetitionGroup) to getting Group details
    const formattedGroups = comp.groups.map(cg => ({
      id: cg.groupId,
      groupName: cg.group.groupName,
      gender: cg.group.gender,
      age: cg.group.age,
      ageEligibilityDate: cg.ageEligibilityDate // Include the specific date
    }));

    const clubIds = comp.clubs.map(club => club.id.toString());

    // For display in list, we might want to show a summary or the first group's date
    // Or just rely on the groups array logic in the frontend.
    // Preserving "age" field as legacy display.

    return {
      id: comp.id,
      competitionName: comp.competitionName,
      maxPlayers: comp.maxPlayers,
      fromDate: comp.fromDate,
      toDate: comp.toDate,
      age: comp.age,
      lastEntryDate: comp.lastEntryDate,
      // ageEligibilityDate removed from root, accessed via groups
      weight: comp.weight,
      rules: comp.rules,
      createdAt: comp.createdAt,
      updatedAt: comp.updatedAt,
      groups: formattedGroups,
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
        include: {
          group: {
            select: {
              id: true,
              groupName: true,
              gender: true,
              age: true,
              ageType: true,
              createdAt: true,
              updatedAt: true
            }
          }
        }
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

  // Referees may only access their assigned competition
  if (req.user && req.user.role === 'referee') {
    if (competition.refereeId !== req.user.id) {
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

  // Format groups to include the joined data nicely
  const formattedGroups = competition.groups.map(cg => ({
    id: cg.groupId, // Keeps compatibility (this identifies the Group, not the join record)
    groupId: cg.groupId, // Add explicit groupId for clarity in frontend
    groupName: cg.group.groupName,
    gender: cg.group.gender,
    age: cg.group.age,
    ageEligibilityDate: cg.ageEligibilityDate
  }));

  // Format the response for frontend compatibility
  const responseData = {
    id: competition.id,
    competitionName: competition.competitionName,
    maxPlayers: competition.maxPlayers,
    fromDate: competition.fromDate,
    toDate: competition.toDate,
    age: competition.age,
    lastEntryDate: competition.lastEntryDate,
    // ageEligibilityDate removed
    weight: competition.weight,
    address: competition.address,
    rules: competition.rules,
    banner: competition.banner,
    createdAt: competition.createdAt,
    updatedAt: competition.updatedAt,
    groups: formattedGroups,
    clubs: clubsWithPlayerCount
  };

  res.json(responseData);
});

const createCompetition = asyncHandler(async (req, res) => {
  // Parse body fields if they come as strings (from multipart/form-data)
  let bodyData = { ...req.body };

  if (req.files && req.files.banner) {
    const bannerFile = req.files.banner[0];
    // Store relative path
    const relativePath = path.relative(process.cwd(), bannerFile.path).replace(/\\/g, '/');
    bodyData.banner = relativePath;
  }

  // Handle parsing of JSON strings or numbers that come as form fields
  if (typeof bodyData.maxPlayers === 'string') bodyData.maxPlayers = parseInt(bodyData.maxPlayers);

  if (typeof bodyData.groups === 'string') {
    try {
      bodyData.groups = JSON.parse(bodyData.groups);
    } catch (e) {
      // If it's not JSON, might be single value - handle as array? 
      // But frontend sends JSON string for complex objects
      console.error("Failed to parse groups JSON", e);
    }
  }

  if (typeof bodyData.clubs === 'string') {
    try {
      bodyData.clubs = JSON.parse(bodyData.clubs);
    } catch (e) {
      // could be comma separated
      bodyData.clubs = bodyData.clubs.split(',').filter(Boolean);
    }
  }

  const schema = z.object({
    competitionName: z.string().min(1, "Competition name is required").max(255),
    maxPlayers: z
      .number()
      .min(10, "Minimum 10 players")
      .max(14, "Maximum 14 players"),
    fromDate: z.string().min(1, "From date is required").max(255),
    toDate: z.string().min(1, "To date is required").max(255),
    // groups is now array of objects { id, ageEligibilityDate }
    groups: z.array(z.object({
      id: z.string(),
      ageEligibilityDate: z.string().min(1, "Eligibility date required for group")
    })).min(1, "At least one group must be selected"),
    clubs: z.array(z.string()).optional(),
    lastEntryDate: z.string().min(1, "Last entry date is required").max(255),
    weight: z.string().max(255).optional(),
    address: z.string().optional(),
    rules: z.string().optional(),
    banner: z.string().optional(),
  });

  // Will throw Zod errors caught by asyncHandler
  const validatedData = await schema.parseAsync(bodyData);

  // Extract groups and clubs for separate handling
  const { groups, clubs, ...competitionData } = validatedData;

  // Cleanup upload if validation fails is handled by middleware

  const normalizedCompetitionData = { ...competitionData };
  if (typeof normalizedCompetitionData.weight === "string") {
    const w = normalizedCompetitionData.weight.trim();
    normalizedCompetitionData.weight = w.length > 0 ? w : null;
  }

  // Determine legacy age string from first group or set default
  let age = "Multiple groups";
  if (groups && groups.length > 0) {
    try {
      const firstGroup = await prisma.group.findUnique({
        where: { id: parseInt(groups[0].id) },
        select: { age: true }
      });
      if (firstGroup) {
        // Also append computed label for the first group for reference
        const computed = computeUnderAgeLabel(groups[0].ageEligibilityDate);
        age = computed || firstGroup.age;
      }
    } catch (e) { console.error(e); }
  }

  // Create the competition with the groups and clubs relationships
  // We need to create CompetitionGroup entries manually or via nested create
  const competition = await prisma.competition.create({
    data: {
      ...normalizedCompetitionData,
      age: age,
      groups: {
        create: groups.map(g => ({
          group: { connect: { id: parseInt(g.id) } },
          ageEligibilityDate: g.ageEligibilityDate
        }))
      },
      ...(clubs && clubs.length > 0 && {
        clubs: {
          connect: clubs.map(clubId => ({ id: parseInt(clubId) }))
        }
      })
    },
    include: {
      groups: {
        include: {
          group: {
            select: {
              id: true,
              groupName: true,
              gender: true,
              age: true,
              ageType: true,
              createdAt: true,
              updatedAt: true
            }
          }
        }
      },
      clubs: true
    }
  });

  res.status(201).json(competition);
});

const updateCompetition = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) throw createError(400, "Invalid competition ID");

  // Parse body fields if they come as strings
  // DEBUG LOGS
  console.log("updateCompetition req.body:", req.body);
  console.log("updateCompetition req.files:", req.files);

  let bodyData = { ...req.body };

  if (req.files && req.files.banner) {
    const bannerFile = req.files.banner[0];
    const relativePath = path.relative(process.cwd(), bannerFile.path).replace(/\\/g, '/');
    bodyData.banner = relativePath;
  }

  if (typeof bodyData.maxPlayers === 'string') bodyData.maxPlayers = parseInt(bodyData.maxPlayers);

  if (typeof bodyData.groups === 'string') {
    try {
      bodyData.groups = JSON.parse(bodyData.groups);
    } catch (e) {
      console.error("Failed to parse groups JSON", e);
    }
  }

  if (typeof bodyData.clubs === 'string') {
    try {
      bodyData.clubs = JSON.parse(bodyData.clubs);
    } catch (e) {
      bodyData.clubs = bodyData.clubs.split(',').filter(Boolean);
    }
  }

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
      // Groups is array of objects { id, ageEligibilityDate }
      groups: z.array(z.object({
        id: z.string(),
        ageEligibilityDate: z.string().min(1)
      })).min(1).optional(),
      clubs: z.array(z.string()).optional(),
      lastEntryDate: z.string().min(1).max(255).optional(),
      weight: z.string().max(255).optional(),
      address: z.string().optional(),
      rules: z.string().optional(),
      banner: z.string().optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: "At least one field is required",
    });

  const validatedData = await schema.parseAsync(bodyData);

  const existing = await prisma.competition.findUnique({
    where: { id },
    include: { groups: true, clubs: true }
  });

  if (!existing) throw createError(404, "Competition not found");

  const { groups, clubs, ...competitionData } = validatedData;
  const updateData = { ...competitionData };

  if (Object.prototype.hasOwnProperty.call(competitionData, "weight") && typeof competitionData.weight === "string") {
    const w = competitionData.weight.trim();
    updateData.weight = w.length > 0 ? w : null;
  }

  // Update groups if provided involves clearing existing and re-creating them
  // Because explicit Many-to-Many via CompetitionGroup requires handling the extra field
  if (groups && groups.length > 0) {
    // Delete existing relation records
    await prisma.competitionGroup.deleteMany({
      where: { competitionId: id }
    });

    // We will use nested create in the update to re-add them
    updateData.groups = {
      create: groups.map(g => ({
        group: { connect: { id: parseInt(g.id) } },
        ageEligibilityDate: g.ageEligibilityDate
      }))
    };

    // Update legacy age label for display
    try {
      const firstGroup = await prisma.group.findUnique({ where: { id: parseInt(groups[0].id) } });
      if (firstGroup) {
        const computed = computeUnderAgeLabel(groups[0].ageEligibilityDate);
        updateData.age = computed || firstGroup.age;
      }
    } catch (e) { }
  }

  // Update clubs relationship if provided
  if (clubs !== undefined) {
    updateData.clubs = {
      set: [],
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
      clubs: true,
      groups: {
        include: {
          group: true
        }
      }
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
      clubs: true,
      groups: {
        include: {
          group: true
        }
      },
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
      groups: {
        select: {
          id: true,
          groupName: true,
          gender: true
        }
      }
    },
    orderBy: [
      { firstName: 'asc' },
      { lastName: 'asc' }
    ]
  });

  // Get groupId from query params (optional)
  const groupId = req.query.groupId ? parseInt(req.query.groupId) : null;

  // Find the specific competition group if groupId is provided
  const targetGroup = groupId
    ? competition.groups.find(g => g.groupId === groupId)
    : null;

  // Mark each player with eligible status
  const playersWithEligibility = players.map(player => {
    let eligible = false;
    let reason = "";

    if (targetGroup) {
      // Check gender: player must belong to a group with matching gender
      const targetGender = (targetGroup.group?.gender || "").toLowerCase().trim();
      const playerHasMatchingGender = player.groups.some(
        pg => (pg.gender || "").toLowerCase().trim() === targetGender
      );

      if (!playerHasMatchingGender) {
        return { ...player, eligible: false, reason: `Gender does not match group '${targetGroup.group?.groupName || "Unknown"}' (requires ${targetGender})` };
      }

      // Check age eligibility
      if (targetGroup.ageEligibilityDate) {
        const dob = new Date(player.dateOfBirth);
        const cutoff = new Date(targetGroup.ageEligibilityDate);
        const ageType = targetGroup.ageType || targetGroup.group?.ageType || "UNDER";

        if (ageType === "ABOVE") {
          // Must be born ON or BEFORE cutoff (older)
          if (dob > cutoff) {
            return { ...player, eligible: false, reason: `Too young - must be born on or before ${cutoff.toISOString().split('T')[0]}` };
          }
        } else {
          // UNDER: Must be born ON or AFTER cutoff (younger)
          if (dob < cutoff) {
            return { ...player, eligible: false, reason: `Too old - must be born on or after ${cutoff.toISOString().split('T')[0]}` };
          }
        }
      }

      eligible = true;
    } else {
      // No specific group selected - check against ALL competition groups
      const qualifyingGroups = competition.groups.filter(group => {
        const groupGender = (group.group?.gender || "").toLowerCase().trim();
        const playerHasGender = player.groups.some(
          pg => (pg.gender || "").toLowerCase().trim() === groupGender
        );
        if (!playerHasGender) return false;

        if (group.ageEligibilityDate) {
          const dob = new Date(player.dateOfBirth);
          const cutoff = new Date(group.ageEligibilityDate);
          const ageType = group.ageType || group.group?.ageType || "UNDER";

          if (ageType === "ABOVE") {
            return dob <= cutoff;
          } else {
            return dob >= cutoff;
          }
        }
        return true;
      });

      eligible = qualifyingGroups.length > 0;
      if (!eligible) {
        reason = "Does not meet gender/age criteria for any group in this competition";
      }
    }

    return { ...player, eligible, reason };
  });

  // Sort: eligible first, then ineligible
  playersWithEligibility.sort((a, b) => {
    if (a.eligible && !b.eligible) return -1;
    if (!a.eligible && b.eligible) return 1;
    return (a.firstName || "").localeCompare(b.firstName || "");
  });

  res.json({
    players: playersWithEligibility,
    totalPlayers: playersWithEligibility.length,
  });
});

// Add players to competition
const addPlayersToCompetition = asyncHandler(async (req, res) => {
  const competitionId = parseInt(req.params.id);
  const { playerIds, groupId, captainId } = req.body;

  if (!competitionId) throw createError(400, "Invalid competition ID");
  if (!playerIds || !Array.isArray(playerIds) || playerIds.length === 0) {
    throw createError(400, "Player IDs are required");
  }
  if (!groupId) throw createError(400, "Group ID is required");

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
      clubs: true,
      groups: {
        include: {
          group: true,
        },
      },
    }
  });

  if (!competition) throw createError(404, "Competition not found");

  // Validate that this group is part of the competition
  const parsedGroupId = parseInt(groupId);
  const targetCompGroup = competition.groups.find(g => g.groupId === parsedGroupId);
  if (!targetCompGroup) {
    throw createError(400, "This group is not part of this competition");
  }

  // Check if club is part of this competition
  const hasAccess = competition.clubs.some(club => club.id === userClubId);
  if (!hasAccess) {
    throw createError(403, "Your club is not part of this competition");
  }

  // Validate max players limit
  if (playerIds.length > competition.maxPlayers) {
    throw createError(400, `Maximum ${competition.maxPlayers} players allowed`);
  }
  const today = new Date();

  // Determine senior competition status based on groups (if any group is over 30/senior)
  // For simplicity, we can check if any of the competition groups have an "Open" or "Senior" age category
  // Or stick to the implementation plan: check if "Men" or "Women" groups are involved.
  const groupNames = competition.groups.map(g => g.group.groupName.trim().toLowerCase());
  const isSeniorCompetition = groupNames.includes("men") || groupNames.includes("women");
  const under18Cutoff = new Date(today.getFullYear() - 18, today.getMonth(), today.getDate());

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

  // Validate eligibility for each player against the TARGET group
  const ineligiblePlayers = [];

  for (const player of players) {
    let isEligible = false;
    const eligibilityDate = new Date(targetCompGroup.ageEligibilityDate);
    const ageType = targetCompGroup.group.ageType || "UNDER";

    if (!isNaN(eligibilityDate.getTime())) {
      const dob = new Date(player.dateOfBirth);
      if (!isNaN(dob.getTime())) {
        if (ageType === "UNDER") {
          if (dob >= eligibilityDate) isEligible = true;
        } else if (ageType === "ABOVE") {
          if (dob <= eligibilityDate) isEligible = true;
        }
      }
    } else {
      isEligible = true; // No date = open group
    }

    if (!isEligible) {
      ineligiblePlayers.push(player);
    }
  }

  if (ineligiblePlayers.length > 0) {
    const names = ineligiblePlayers.map(p => `${p.firstName} ${p.lastName}`).join(", ");
    throw createError(400, `The following players are not eligible for group '${targetCompGroup.group.groupName}': ${names}`);
  }

  // Enforce U18 rules for senior competitions
  if (isSeniorCompetition) {
    const allowU18Extras = true; // Logic from previous code: "Men"/"Women" implies U18 allowed with limits

    // Count existing U18 registrations for this club in this competition
    const existingU18Count = await prisma.competitionRegistration.count({
      where: {
        competitionId,
        clubId: userClubId,
        player: {
          dateOfBirth: {
            gte: under18Cutoff // born on/after cutoff => age 18 or younger
          }
        }
      }
    });

    const incomingU18 = players.filter(p => {
      const age = calculateAgeOn(p.dateOfBirth, today);
      return age !== null && age <= 18;
    }).length;

    const totalU18 = existingU18Count + incomingU18;
    if (totalU18 > 3) {
      const remaining = Math.max(0, 3 - existingU18Count);
      throw createError(400, remaining === 0
        ? "Maximum 3 U18 (age 18 or below) players already registered for this competition"
        : `You can register only ${remaining} more U18 (age 18 or below) player(s) for this competition (max 3)`);
    }
  }

  // Create registration records for each player
  const registrationData = players.map(player => ({
    competitionId: competitionId,
    playerId: player.id,
    clubId: userClubId,
    groupId: parsedGroupId,
    registeredBy: req.user.email,
    status: 'registered'
  }));

  // Use transaction to ensure all registrations are created atomically
  const registrations = await prisma.$transaction(async (tx) => {
    // Check for existing registrations for this group to avoid duplicates
    const existingRegistrations = await tx.competitionRegistration.findMany({
      where: {
        competitionId: competitionId,
        groupId: parsedGroupId,
        playerId: { in: playerIds.map(id => parseInt(id)) }
      }
    });

    const existingPlayerIds = existingRegistrations.map(reg => reg.playerId);
    const newRegistrations = registrationData.filter(reg => !existingPlayerIds.includes(reg.playerId));

    if (newRegistrations.length === 0) {
      throw createError(400, "All selected players are already registered for this group");
    }

    // Enforce max players per group when adding incrementally
    const currentCount = await tx.competitionRegistration.count({
      where: {
        competitionId: competitionId,
        clubId: userClubId,
        groupId: parsedGroupId,
      },
    });
    if (currentCount + newRegistrations.length > competition.maxPlayers) {
      const remaining = Math.max(0, competition.maxPlayers - currentCount);
      throw createError(400, remaining === 0
        ? `Maximum ${competition.maxPlayers} players already registered for this group`
        : `You can register only ${remaining} more player(s) for this group. Maximum ${competition.maxPlayers} allowed`);
    }

    // Create new registrations
    await tx.competitionRegistration.createMany({
      data: newRegistrations
    });

    // Set captain if captainId is provided
    if (captainId) {
      const parsedCaptainId = parseInt(captainId);
      // Unset any existing captain for this club+group+competition
      await tx.competitionRegistration.updateMany({
        where: {
          competitionId: competitionId,
          clubId: userClubId,
          groupId: parsedGroupId,
          captain: true,
        },
        data: { captain: false },
      });
      // Set captain on the matching registration
      await tx.competitionRegistration.updateMany({
        where: {
          competitionId: competitionId,
          clubId: userClubId,
          groupId: parsedGroupId,
          playerId: parsedCaptainId,
        },
        data: { captain: true },
      });
    }

    // Fetch the created registrations with related data
    return await tx.competitionRegistration.findMany({
      where: {
        competitionId: competitionId,
        groupId: parsedGroupId,
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
      group: {
        select: {
          id: true,
          groupName: true,
          gender: true,
          age: true,
          ageType: true,
        }
      },
      competition: {
        select: {
          id: true,
          competitionName: true,
          maxPlayers: true,
          age: true,
          weight: true
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
      captain: reg.captain,
      groupId: reg.groupId,
      group: reg.group,
      managerName: reg.managerName,
      coachName: reg.coachName,
      player: {
        id: reg.player.id,
        name: `${reg.player.firstName} ${reg.player.lastName}`,
        uniqueIdNumber: reg.player.uniqueIdNumber,
        position: reg.player.position,
        dateOfBirth: reg.player.dateOfBirth,
        age: calculateAgeOn(reg.player.dateOfBirth) ?? 0
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

  console.log(`[PDF DEBUG] Generating PDF. Comp: ${competitionId}, Club: ${clubId}, Group: ${req.query.groupId}`);

  console.log(`[PDF DEBUG] Generating PDF for Comp: ${competitionId}, Club: ${clubId}, Group: ${req.query.groupId || 'All'}`);

  // Fetch competition details
  const competition = await prisma.competition.findUnique({
    where: { id: competitionId },
    select: {
      id: true,
      competitionName: true,
      fromDate: true,
      toDate: true,
      age: true,
      // ageEligibilityDate removed
      weight: true,
      maxPlayers: true,
      lastEntryDate: true,
      groups: {
        include: {
          group: true
        }
      }
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

  // Check if filtering by group
  const groupId = req.query.groupId ? parseInt(req.query.groupId) : null;
  let groupName = "";

  if (groupId) {
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      select: { groupName: true }
    });
    if (group) {
      groupName = group.groupName;
    }
  }

  // Fetch registered players for this club in this competition
  const where = {
    competitionId: competitionId,
    clubId: clubId
  };

  if (groupId) {
    where.groupId = groupId;
  }

  const registrations = await prisma.competitionRegistration.findMany({
    where,
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
          chestNumber: true,
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

  console.log(`[PDF DEBUG] Found ${registrations.length} registrations`);

  // Create PDF document with better margins
  const doc = new PDFDocument({
    margin: 40,
    size: 'A4',
    info: {
      Title: `${club.clubName} - ${competition.competitionName} ${groupName ? `(${groupName}) ` : ''}Registration Details`,
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

  const resolveMeritCertificateTemplatePath = () => {
    const candidates = [
      path.resolve(__dirname, '..', '..', '..', 'assets', 'merit-certificate-template.jpg'),
      path.resolve(__dirname, '..', '..', '..', 'assets', 'merit-certificate-template.jpeg'),
      path.resolve(__dirname, '..', '..', '..', 'assets', 'merit-certificate-template.png'),
      path.resolve(process.cwd(), 'assets', 'merit-certificate-template.jpg'),
      path.resolve(process.cwd(), 'assets', 'merit-certificate-template.jpeg'),
      path.resolve(process.cwd(), 'assets', 'merit-certificate-template.png'),
      path.resolve(__dirname, '../../..', 'backend', 'assets', 'merit-certificate-template.jpg'),
      path.resolve(__dirname, '../../..', 'backend', 'assets', 'merit-certificate-template.jpeg'),
      path.resolve(__dirname, '../../..', 'backend', 'assets', 'merit-certificate-template.png'),
      path.resolve(__dirname, '../../..', 'frontend', 'public', 'merit-certificate-template.jpg'),
      path.resolve(__dirname, '../../..', 'frontend', 'public', 'merit-certificate-template.jpeg'),
      path.resolve(__dirname, '../../..', 'frontend', 'public', 'merit-certificate-template.png'),
      path.resolve(__dirname, '../../..', 'backend', 'uploads', 'players', 'profileImage', '270e56b1-67a4-4fb6-91bb-f15a995bc701', 'Certificate-1.jpeg'),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch (_) {
        // ignore
      }
    }
    return null;
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

  const primaryRed = '#dc2626';
  const borderColor = '#000000';

  const pageLeft = doc.page.margins.left;
  const pageRight = doc.page.width - doc.page.margins.right;
  const pageTop = doc.page.margins.top;
  const pageBottom = doc.page.height - doc.page.margins.bottom;
  const contentW = pageRight - pageLeft;

  const safeText = (v) => (v === null || v === undefined || String(v).trim() === '' ? '-' : String(v));

  const formatDateDMY = (d) => {
    if (!d) return '-';
    try {
      const dt = new Date(d);
      const dd = String(dt.getDate()).padStart(2, '0');
      const mm = String(dt.getMonth() + 1).padStart(2, '0');
      const yyyy = String(dt.getFullYear());
      return `${dd}-${mm}-${yyyy}`;
    } catch (_) {
      return '-';
    }
  };

  const resolveTDKALogoPath = () => {
    const candidates = [
      path.resolve(__dirname, '../../..', 'frontend', 'public', 'TDKA logo.png'),
      path.resolve(__dirname, '../../..', 'frontend', 'dist', 'TDKA logo.png'),
      path.resolve(process.cwd(), 'frontend', 'public', 'TDKA logo.png'),
      path.resolve(process.cwd(), 'frontend', 'dist', 'TDKA logo.png'),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch (_) {
        // ignore
      }
    }
    return null;
  };

  // Determine label from groups or legacy age field
  let underLabelRaw = competition.age || '';
  if (competition.groups && competition.groups.length > 0) {
    // Try to construct a label from groups if age is missing or checks
    // For now, rely on competition.age which is updated on save, or join group ages
    if (!underLabelRaw) {
      underLabelRaw = competition.groups.map(g => g.group?.age || '').filter(Boolean).join(' / ');
    }
  }

  const entryAgeTitle = (() => {
    const m = String(underLabelRaw).match(/Under\s+(\d+)/i);
    if (m?.[1]) return `under ${m[1]}th -`;
    return String(underLabelRaw || '').trim() ? `${String(underLabelRaw).toLowerCase()} -` : '';
  })();

  const locationParts = [club.address, club.city, club.place?.placeName, club.place?.region?.regionName]
    .map((x) => (x ? String(x).trim() : ''))
    .filter(Boolean);
  const clubLocation = locationParts.join(', ') || '-';

  const logoPath = resolveTDKALogoPath();
  const headerY = pageTop;
  const logoSize = 56;
  const logoX = pageLeft;
  const logoY = headerY;

  if (logoPath) {
    try {
      doc.image(logoPath, logoX, logoY, { fit: [logoSize, logoSize] });
    } catch (_) {
      // ignore
    }
  }

  const assocName = 'THANE DISTRICT KABADDI ASSOCIATION';
  const assocLine1 = `Office: ${safeText(clubLocation)}`;
  const assocLine2 = `Phone: ${safeText(club.mobile)}   Email: ${safeText(club.email)}`;

  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .fillColor(primaryRed)
    .text(assocName, pageLeft, headerY + 2, { width: contentW, align: 'center' });
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('black')
    .text(assocLine1, pageLeft, headerY + 26, { width: contentW, align: 'center' });
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('black')
    .text(assocLine2, pageLeft, headerY + 40, { width: contentW, align: 'center' });

  doc
    .moveTo(pageLeft, headerY + 66)
    .lineTo(pageRight, headerY + 66)
    .lineWidth(1)
    .stroke(borderColor);

  const entryTitle = `ENTRY FORM For "${safeText(club.clubName)}"`;
  doc.font('Helvetica-Bold').fontSize(12).fillColor('black');
  doc.text(entryTitle, pageLeft, headerY + 74, { width: contentW, align: 'center' });

  const titleW = Math.min(contentW - 20, doc.widthOfString(entryTitle));
  doc
    .moveTo(pageLeft + contentW / 2 - titleW / 2, headerY + 90)
    .lineTo(pageLeft + contentW / 2 + titleW / 2, headerY + 90)
    .lineWidth(1)
    .stroke(borderColor);

  let y = headerY + 104;
  const labelX = pageLeft;
  const labelW = 170;
  const valueX = labelX + labelW + 10;
  const valueW = pageRight - valueX;
  const minRowH = 16;

  const drawField = (label, value) => {
    const labelText = safeText(label);
    const valueText = safeText(value);

    doc.font('Helvetica-Bold').fontSize(9).fillColor('black');
    const labelH = doc.heightOfString(labelText, { width: labelW });

    doc.font('Helvetica').fontSize(9).fillColor('black');
    const valueH = doc.heightOfString(valueText, { width: valueW });

    const rowH = Math.max(minRowH, labelH, valueH);

    doc.font('Helvetica-Bold').fontSize(9).fillColor('black').text(labelText, labelX, y, { width: labelW });
    doc.font('Helvetica').fontSize(9).fillColor('black').text(valueText, valueX, y, { width: valueW });

    y += rowH;
  };

  drawField('Name of Tournament:', competition.competitionName);
  drawField('Name of Organiser:', club.clubName);
  drawField('Tournament address:', clubLocation);
  drawField('Tournament Valid From:', `${formatDateDMY(competition.fromDate)}     To: ${formatDateDMY(competition.toDate)}`);
  drawField('City:', club.city || '-');
  drawField('The following Players will represent:', club.clubName);

  y += 6;
  doc.moveTo(pageLeft, y).lineTo(pageRight, y).lineWidth(1).stroke(borderColor);
  y += 10;

  if (entryAgeTitle) {
    doc.font('Helvetica-Bold').fontSize(12).fillColor('black').text(entryAgeTitle, pageLeft, y, { width: contentW, align: 'center' });
    y += 18;
  }

  const tableX = pageLeft;
  const tableW = contentW;
  const colW = {
    sr: 30,
    name: 190,
    chest: 60,
    dob: 70,
    mem: tableW - (30 + 190 + 60 + 70),
  };

  const drawCell = (text, x, y0, w, h, opts = {}) => {
    doc.rect(x, y0, w, h).lineWidth(0.8).stroke(borderColor);
    const pad = 4;
    doc
      .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(opts.size || 9)
      .fillColor('black');

    doc.save();
    doc
      .rect(x + pad, y0 + pad, Math.max(0, w - pad * 2), Math.max(0, h - pad * 2))
      .clip();
    doc.text(text ?? '', x + pad, y0 + pad, {
      width: w - pad * 2,
      align: opts.align || 'left',
    });
    doc.restore();
  };

  const drawTableHeader = () => {
    const h = 28;
    let x = tableX;
    drawCell('Sr\nNo.', x, y, colW.sr, h, { bold: true, align: 'center', size: 9 });
    x += colW.sr;
    drawCell("Name of the Player's\n(In Block Letters)", x, y, colW.name, h, { bold: true, align: 'center', size: 9 });
    x += colW.name;
    drawCell('Chest No', x, y, colW.chest, h, { bold: true, align: 'center', size: 9 });
    x += colW.chest;
    drawCell('Birth Date', x, y, colW.dob, h, { bold: true, align: 'center', size: 9 });
    x += colW.dob;
    drawCell('Membership\nNo.', x, y, colW.mem, h, { bold: true, align: 'center', size: 9 });
    y += h;
  };

  drawTableHeader();

  const maxYForRows = () => pageBottom - 230;
  const minRowHeight = 18;
  const cellPad = 4;

  registrations.forEach((reg, idx) => {
    const p = reg.player;
    const fullName = [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ').toUpperCase();
    const membershipNo = (p.uniqueIdNumber || '').toString().split('/').pop() || p.uniqueIdNumber || '';

    doc.font('Helvetica').fontSize(9);
    const nameTextH = doc.heightOfString(fullName || '-', { width: colW.name - cellPad * 2 });
    const rowHeight = Math.max(minRowHeight, nameTextH + cellPad * 2);

    if (y + rowHeight > maxYForRows()) {
      doc.addPage();
      y = doc.page.margins.top;
      drawTableHeader();
    }

    let x = tableX;
    drawCell(String(idx + 1), x, y, colW.sr, rowHeight, { align: 'center' });
    x += colW.sr;
    drawCell(fullName, x, y, colW.name, rowHeight);
    x += colW.name;
    drawCell(p.chestNumber || '-', x, y, colW.chest, rowHeight, { align: 'center' });
    x += colW.chest;
    drawCell(formatDateDMY(p.dateOfBirth), x, y, colW.dob, rowHeight, { align: 'center' });
    x += colW.dob;
    drawCell(membershipNo, x, y, colW.mem, rowHeight, { align: 'center' });
    y += rowHeight;
  });

  y += 10;
  if (y > pageBottom - 90) {
    doc.addPage();
    y = doc.page.margins.top;
  }

  const bottomLabelX = pageLeft;
  const bottomValueX = pageLeft + 150;
  const bottomRowH = 14;
  const drawBottomLine = (label, value) => {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('black').text(label, bottomLabelX, y);
    doc.font('Helvetica').fontSize(9).fillColor('black').text(safeText(value), bottomValueX, y);
    y += bottomRowH;
  };

  // Find captain from registrations
  const captainRegistration = registrations.find(reg => reg.captain === true);
  const captainName = captainRegistration
    ? [captainRegistration.player.firstName, captainRegistration.player.middleName, captainRegistration.player.lastName].filter(Boolean).join(' ').toUpperCase()
    : '';

  // Get manager and coach names from any registration (they're the same for all registrations in a club)
  const anyRegistration = registrations.find(reg => reg.managerName || reg.coachName);
  const managerName = anyRegistration?.managerName || '';
  const coachName = anyRegistration?.coachName || '';

  drawBottomLine('Name of the Captain:', captainName);
  drawBottomLine('Name of the Manager:', managerName);
  drawBottomLine('Name of the Coach:', coachName);

  y += 6;
  const note =
    'We certify that the above mentioned players are bonafide players of the District / Club are eligible to participate in the said Championship. The chest numbers given above to the players will not be changed without prior permission of the Technical Committee of MAHARASHTRA KABADDI ASSOCIATION. We certify that the age certificates registration forms of the participants to the Association have been verified and found correct. In the event of any wrong information we shall be held responsible and the player whose certificate found defective will be disqualified from the Championship.';
  doc.font('Helvetica').fontSize(8).fillColor('black').text(note, pageLeft, y, { width: contentW, align: 'justify' });

  {
    const clubNameUpper = String(club.clubName || '').toUpperCase();
    const midTitleY = pageBottom - 120;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('black').text(clubNameUpper || '-', pageLeft, midTitleY, {
      width: contentW,
      align: 'center',
    });

    const footerY1 = pageBottom - 56;
    const footerY2 = pageBottom - 42;
    doc.font('Helvetica').fontSize(8).fillColor('black').text('seal of the association', pageLeft, footerY1);
    doc.font('Helvetica').fontSize(8).fillColor('black').text('secretary', pageLeft, footerY1, { width: contentW, align: 'right' });
    doc.font('Helvetica').fontSize(8).fillColor('black').text(clubNameUpper || '-', pageLeft, footerY2, { width: contentW, align: 'right' });
  }

  const resolveLocalImagePath = (p) => {
    if (!p) return null;
    if (/^https?:\/\//i.test(p)) return null;
    try {
      if (path.isAbsolute(p)) return fs.existsSync(p) ? p : null;
    } catch (_) {
      return null;
    }

    const candidates = [
      path.resolve(process.cwd(), p),
      path.resolve(process.cwd(), 'backend', p),
      path.resolve(__dirname, '../../..', p),
      path.resolve(__dirname, '../../..', 'backend', p),
    ];

    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch (_) {
        // ignore
      }
    }
    return null;
  };

  doc.addPage();

  const drawPlayersPageHeader = () => {
    const topY = doc.page.margins.top;

    if (logoPath) {
      try {
        doc.image(logoPath, pageLeft, topY, { fit: [logoSize, logoSize] });
      } catch (_) {
        // ignore
      }
    }

    doc
      .font('Helvetica-Bold')
      .fontSize(18)
      .fillColor(primaryRed)
      .text(assocName, pageLeft, topY + 2, { width: contentW, align: 'center' });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('black')
      .text(assocLine1, pageLeft, topY + 26, { width: contentW, align: 'center' });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('black')
      .text(assocLine2, pageLeft, topY + 40, { width: contentW, align: 'center' });

    doc.moveTo(pageLeft, topY + 66).lineTo(pageRight, topY + 66).lineWidth(1).stroke(borderColor);

    return topY + 78;
  };

  const drawPlayersPageFooter = () => {
    const footerY1 = pageBottom - 56;
    const footerY2 = pageBottom - 42;

    doc.font('Helvetica').fontSize(8).fillColor('black').text('seal of the association', pageLeft, footerY1);
    doc.font('Helvetica').fontSize(8).fillColor('black').text('secretary', pageLeft, footerY1, { width: contentW, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('black')
      .text(String(club.clubName || '').toUpperCase(), pageLeft, footerY2, { width: contentW, align: 'right' });
  };

  const renderPlayersGrid = () => {
    let gridTop = drawPlayersPageHeader();
    const cols = 4;
    const cellW = contentW / cols;
    const cellH = 148;
    const photoBox = 92;
    const footerReserve = 80;

    const rowsPerPage = Math.max(1, Math.floor((pageBottom - footerReserve - gridTop) / cellH));
    const perPage = rowsPerPage * cols;

    const totalCells = Math.ceil(registrations.length / cols) * cols;

    for (let idx = 0; idx < totalCells; idx++) {
      const posInPage = idx % perPage;
      if (idx > 0 && posInPage === 0) {
        drawPlayersPageFooter();
        doc.addPage();
        gridTop = drawPlayersPageHeader();
      }

      const row = Math.floor(posInPage / cols);
      const col = posInPage % cols;
      const x0 = pageLeft + col * cellW;
      const y0 = gridTop + row * cellH;

      doc.rect(x0, y0, cellW, cellH).lineWidth(0.8).stroke(borderColor);

      const reg = registrations[idx];
      if (!reg?.player) continue;

      const p = reg.player;
      const fullName = [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ').toUpperCase();

      const imgPath = resolveLocalImagePath(p.profileImage);
      const imageToUse = imgPath || logoPath;

      const imgX = x0 + (cellW - photoBox) / 2;
      const imgY = y0 + 10;

      if (imageToUse) {
        try {
          doc.image(imageToUse, imgX + 4, imgY + 4, {
            fit: [photoBox - 8, photoBox - 8],
            align: 'center',
            valign: 'center',
          });
        } catch (_) {
          doc
            .font('Helvetica')
            .fontSize(7)
            .fillColor('black')
            .text('PHOTO', imgX, imgY + photoBox / 2 - 4, { width: photoBox, align: 'center' });
        }
      }

      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor('black')
        .text(fullName || '-', x0 + 6, imgY + photoBox + 10, { width: cellW - 12, align: 'center' });
    }

    drawPlayersPageFooter();
  };

  renderPlayersGrid();

  console.log('[PDF DEBUG] Rendered grid. Calling doc.end()');
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
          profileImage: true,
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
    captain: reg.captain,
    groupId: reg.groupId,
    player: {
      id: reg.player.id,
      name: `${reg.player.firstName} ${reg.player.middleName ? reg.player.middleName + ' ' : ''}${reg.player.lastName}`,
      uniqueIdNumber: reg.player.uniqueIdNumber,
      profileImage: reg.player.profileImage,
      position: reg.player.position,
      mobile: reg.player.mobile,
      age: calculateAgeOn(reg.player.dateOfBirth) ?? 0,
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

// Set captain for a competition registration
const setCaptain = asyncHandler(async (req, res) => {
  const competitionId = parseInt(req.params.id);
  const clubId = parseInt(req.params.clubId);
  const registrationId = parseInt(req.params.registrationId);

  if (!competitionId || !clubId || !registrationId) {
    throw createError(400, "Invalid competition ID, club ID, or registration ID");
  }

  // Get user's club ID from auth
  let userClubId = null;
  if (req.user) {
    if (req.user.role === 'clubadmin' && req.user.clubId) {
      userClubId = req.user.clubId;
    } else if (req.user.role === 'CLUB') {
      const clubAdminUser = await prisma.user.findFirst({
        where: { email: req.user.email, role: 'clubadmin' },
        select: { clubId: true },
      });
      if (clubAdminUser?.clubId) userClubId = clubAdminUser.clubId;
    } else if (req.user.role === 'admin') {
      // Admin can set captain for any club
      userClubId = clubId;
    }
  }

  if (!userClubId || userClubId !== clubId) {
    throw createError(403, "Access denied - you can only set captain for your own club");
  }

  // First, unset any existing captain for this club in this competition
  await prisma.competitionRegistration.updateMany({
    where: {
      competitionId: competitionId,
      clubId: clubId,
      captain: true
    },
    data: { captain: false }
  });

  // Set the new captain
  const registration = await prisma.competitionRegistration.update({
    where: {
      id: registrationId,
      competitionId: competitionId,
      clubId: clubId
    },
    data: { captain: true },
    include: {
      player: {
        select: {
          id: true,
          firstName: true,
          lastName: true
        }
      }
    }
  });

  if (!registration) {
    throw createError(404, "Registration not found");
  }

  res.json({
    message: `${registration.player.firstName} ${registration.player.lastName} is now the captain`,
    registration: {
      id: registration.id,
      captain: registration.captain,
      player: registration.player
    }
  });
});

// Get competition club info (manager and coach names)
const getCompetitionClubInfo = asyncHandler(async (req, res) => {
  const competitionId = parseInt(req.params.id);
  const clubId = parseInt(req.params.clubId);

  if (!competitionId || !clubId) {
    throw createError(400, "Invalid competition ID or club ID");
  }

  // Check permissions
  let userClubId = null;
  if (req.user) {
    if (req.user.role === 'clubadmin' && req.user.clubId) {
      userClubId = req.user.clubId;
    } else if (req.user.role === 'CLUB') {
      const clubAdminUser = await prisma.user.findFirst({
        where: { email: req.user.email, role: 'clubadmin' },
        select: { clubId: true },
      });
      if (clubAdminUser?.clubId) userClubId = clubAdminUser.clubId;
    } else if (req.user.role === 'admin') {
      userClubId = clubId;
    }
  }

  if (!userClubId || userClubId !== clubId) {
    throw createError(403, "Access denied");
  }

  // Get any registration for this club in this competition to get manager/coach
  // If groupId is provided, get info for that specific group
  const groupId = req.query.groupId ? parseInt(req.query.groupId) : null;

  const where = {
    competitionId: competitionId,
    clubId: clubId
  };
  if (groupId) where.groupId = groupId;

  const registration = await prisma.competitionRegistration.findFirst({
    where
  });

  res.json({
    managerName: registration?.managerName || '',
    coachName: registration?.coachName || ''
  });
});

// Update competition club info (manager and coach names)
const updateCompetitionClubInfo = asyncHandler(async (req, res) => {
  const competitionId = parseInt(req.params.id);
  const clubId = parseInt(req.params.clubId);

  if (!competitionId || !clubId) {
    throw createError(400, "Invalid competition ID or club ID");
  }

  // Check permissions
  let userClubId = null;
  if (req.user) {
    if (req.user.role === 'clubadmin' && req.user.clubId) {
      userClubId = req.user.clubId;
    } else if (req.user.role === 'CLUB') {
      const clubAdminUser = await prisma.user.findFirst({
        where: { email: req.user.email, role: 'clubadmin' },
        select: { clubId: true },
      });
      if (clubAdminUser?.clubId) userClubId = clubAdminUser.clubId;
    } else if (req.user.role === 'admin') {
      userClubId = clubId;
    }
  }

  if (!userClubId || userClubId !== clubId) {
    throw createError(403, "Access denied");
  }

  const schema = z.object({
    managerName: z.string().max(255, "Manager name must not exceed 255 characters").optional(),
    coachName: z.string().max(255, "Coach name must not exceed 255 characters").optional(),
  });

  const { managerName, coachName } = await schema.parseAsync(req.body);

  // Update registrations - if groupId provided, only update that group's registrations
  const groupId = req.body.groupId ? parseInt(req.body.groupId) : null;

  const where = {
    competitionId: competitionId,
    clubId: clubId
  };
  if (groupId) where.groupId = groupId;

  await prisma.competitionRegistration.updateMany({
    where,
    data: {
      managerName: managerName || null,
      coachName: coachName || null
    }
  });

  res.json({
    message: "Manager and coach information updated successfully",
    clubInfo: {
      managerName: managerName || null,
      coachName: coachName || null
    }
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
      // ageEligibilityDate removed
      weight: true,
      lastEntryDate: true,
      groups: {
        include: { group: true }
      },
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

  let pdfAgeLabel = competition.age || '';
  if (competition.groups && competition.groups.length > 0 && !pdfAgeLabel) {
    pdfAgeLabel = competition.groups.map(g => g.group.age).join(' / ');
  }

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
  const clubs = [...competition.clubs].sort((a, b) => a.clubName.localeCompare(b.clubName));
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
  doc.text(`Generated on: ${new Date().toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`, 50, footerY + 20);

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
    refereeId: z.preprocess(
      (val) => {
        if (val === "" || val === null || val === undefined) return undefined;
        const num = Number(val);
        return Number.isNaN(num) ? undefined : num;
      },
      z.number().int("Invalid referee ID")
    ),
  });

  const { refereeId } = await schema.parseAsync(req.body);

  // Ensure competition exists and doesn't already have a referee
  const competition = await prisma.competition.findUnique({
    where: { id: competitionId },
    select: { id: true, competitionName: true, refereeId: true }
  });

  if (!competition) throw createError(404, "Competition not found");
  if (competition.refereeId) {
    throw createError(400, "A referee is already assigned to this competition");
  }

  const refereeUser = await prisma.user.findUnique({
    where: { id: refereeId },
    select: { id: true, name: true, email: true, role: true, active: true },
  });

  if (!refereeUser) {
    throw createError(404, "Referee user not found");
  }
  if (typeof refereeUser.role !== 'string' || refereeUser.role.toLowerCase() !== 'referee') {
    throw createError(400, "Selected user is not a referee");
  }
  if (!refereeUser.active) {
    throw createError(400, "Selected referee is not active");
  }

  const refereeProfile = await prisma.referee.findUnique({
    where: { userId: refereeUser.id },
    select: { id: true },
  });
  if (!refereeProfile) {
    throw createError(400, "Selected referee does not have a referee profile");
  }

  // Assign to competition
  await prisma.competition.update({
    where: { id: competitionId },
    data: { refereeId: refereeUser.id }
  });

  res.status(201).json({
    message: "Referee assigned successfully",
    referee: { id: refereeUser.id, name: refereeUser.name, email: refereeUser.email, role: refereeUser.role },
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
    refereeId: z.preprocess(
      (val) => {
        if (val === "" || val === null || val === undefined) return undefined;
        const num = Number(val);
        return Number.isNaN(num) ? undefined : num;
      },
      z.number().int("Invalid referee ID")
    ),
  });

  const { refereeId } = await schema.parseAsync(req.body);

  const competition = await prisma.competition.findUnique({
    where: { id: competitionId },
    select: { refereeId: true },
  });

  if (!competition) throw createError(404, 'Competition not found');

  const refereeUser = await prisma.user.findUnique({
    where: { id: refereeId },
    select: { id: true, name: true, email: true, role: true, active: true },
  });

  if (!refereeUser) {
    throw createError(404, "Referee user not found");
  }
  if (typeof refereeUser.role !== 'string' || refereeUser.role.toLowerCase() !== 'referee') {
    throw createError(400, "Selected user is not a referee");
  }
  if (!refereeUser.active) {
    throw createError(400, "Selected referee is not active");
  }

  const refereeProfile = await prisma.referee.findUnique({
    where: { userId: refereeUser.id },
    select: { id: true },
  });
  if (!refereeProfile) {
    throw createError(400, "Selected referee does not have a referee profile");
  }

  await prisma.competition.update({
    where: { id: competitionId },
    data: { refereeId: refereeUser.id },
  });

  const hadExisting = !!competition.refereeId;
  res.json({
    message: hadExisting ? 'Referee updated successfully' : 'Referee assigned successfully',
    referee: { id: refereeUser.id, name: refereeUser.name, email: refereeUser.email, role: refereeUser.role },
  });
});

const generateMeritCertificatePDF = asyncHandler(async (req, res) => {
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
      const clubAdminUser = await prisma.user.findFirst({
        where: {
          email: req.user.email,
          role: "clubadmin",
        },
        select: { clubId: true },
      });
      if (clubAdminUser?.clubId) {
        userClubId = clubAdminUser.clubId;
      }
    }
  }

  if (!userClubId) {
    return res.status(403).json({ errors: { message: "Access denied" } });
  }

  const competition = await prisma.competition.findUnique({
    where: { id: competitionId },
    select: {
      id: true,
      competitionName: true,
      fromDate: true,
      toDate: true,
      age: true,
      // ageEligibilityDate removed
      weight: true,
    },
  });

  if (!competition) {
    throw createError(404, "Competition not found");
  }

  const endDate = parseEligibilityDate(competition.toDate);
  if (endDate) {
    endDate.setHours(23, 59, 59, 999);
  }

  if (endDate && new Date() <= endDate) {
    throw createError(400, "Merit certificate is available only after the competition period is over");
  }

  const registration = await prisma.competitionRegistration.findFirst({
    where: {
      competitionId: competitionId,
      clubId: userClubId,
      playerId: playerId,
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
          profileImage: true,
        },
      },
    },
  });

  if (!registration?.player) {
    throw createError(404, "Player is not registered for this competition");
  }

  const club = await prisma.club.findUnique({
    where: { id: userClubId },
    select: { id: true, clubName: true, city: true },
  });

  const player = registration.player;
  const playerName = [player.firstName, player.middleName, player.lastName].filter(Boolean).join(" ").trim();
  const safeName = String(playerName || "player").replace(/[^a-z0-9_-]+/gi, "_");

  const doc = new PDFDocument({
    margin: 30,
    size: 'A4',
    layout: 'landscape',
    info: {
      Title: `Merit Certificate - ${playerName} - ${competition.competitionName}`,
      Author: 'TDKA Competition Management System',
      Subject: 'Merit Certificate',
    },
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Merit_Certificate_${safeName}.pdf"`);
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  doc.pipe(res);

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const left = doc.page.margins.left;
  const top = doc.page.margins.top;
  const right = pageW - doc.page.margins.right;
  const bottom = pageH - doc.page.margins.bottom;
  const contentW = right - left;

  const formatDateDMY = (d) => {
    if (!d) return '-';
    try {
      const dt = new Date(d);
      const dd = String(dt.getDate()).padStart(2, '0');
      const mm = String(dt.getMonth() + 1).padStart(2, '0');
      const yyyy = String(dt.getFullYear());
      return `${dd}-${mm}-${yyyy}`;
    } catch (_) {
      return '-';
    }
  };

  const resolveTDKALogoPath = () => {
    const candidates = [
      path.resolve(__dirname, '../../..', 'frontend', 'public', 'TDKA logo.png'),
      path.resolve(__dirname, '../../..', 'frontend', 'dist', 'TDKA logo.png'),
      path.resolve(process.cwd(), 'frontend', 'public', 'TDKA logo.png'),
      path.resolve(process.cwd(), 'frontend', 'dist', 'TDKA logo.png'),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch (_) {
        // ignore
      }
    }
    return null;
  };

  const resolveLocalImagePath = (p) => {
    if (!p) return null;
    const raw = String(p).trim();
    const uploadsRoot = path.resolve(__dirname, '..', '..', 'uploads');

    const mapUploadsPath = (maybePath) => {
      if (!maybePath) return null;
      const s = String(maybePath).trim();
      const normalized = s.replace(/\\/g, '/');
      const idx = normalized.toLowerCase().indexOf('/uploads/');
      if (idx >= 0) {
        const rel = normalized.slice(idx + '/uploads/'.length);
        const abs = path.resolve(uploadsRoot, rel);
        try {
          return fs.existsSync(abs) ? abs : null;
        } catch (_) {
          return null;
        }
      }

      if (/^uploads\//i.test(normalized)) {
        const rel = normalized.replace(/^uploads\//i, '');
        const abs = path.resolve(uploadsRoot, rel);
        try {
          return fs.existsSync(abs) ? abs : null;
        } catch (_) {
          return null;
        }
      }

      return null;
    };

    if (/^https?:\/\//i.test(raw)) {
      try {
        const url = new URL(raw);
        const mapped = mapUploadsPath(url.pathname);
        if (mapped) return mapped;
      } catch (_) {
        // ignore
      }
      return null;
    }

    // Map URL-like uploads paths to local uploads folder (important on Windows where /uploads/... is treated as absolute)
    const mapped = mapUploadsPath(raw);
    if (mapped) return mapped;

    try {
      if (path.isAbsolute(raw)) return fs.existsSync(raw) ? raw : null;
    } catch (_) {
      return null;
    }
    const candidates = [
      path.resolve(process.cwd(), raw),
      path.resolve(process.cwd(), 'backend', raw),
      path.resolve(__dirname, '../../..', raw),
      path.resolve(__dirname, '../../..', 'backend', raw),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch (_) {
        // ignore
      }
    }
    return null;
  };

  const resolveMeritCertificateTemplatePath = () => {
    const candidates = [
      path.resolve(__dirname, '..', '..', 'assets', 'merit-certificate-template.jpg'),
      path.resolve(__dirname, '..', '..', 'assets', 'merit-certificate-template.jpeg'),
      path.resolve(__dirname, '..', '..', 'assets', 'merit-certificate-template.png'),
      path.resolve(__dirname, '..', '..', '..', 'assets', 'merit-certificate-template.jpg'),
      path.resolve(__dirname, '..', '..', '..', 'assets', 'merit-certificate-template.jpeg'),
      path.resolve(__dirname, '..', '..', '..', 'assets', 'merit-certificate-template.png'),
      path.resolve(process.cwd(), 'assets', 'merit-certificate-template.jpg'),
      path.resolve(process.cwd(), 'assets', 'merit-certificate-template.jpeg'),
      path.resolve(process.cwd(), 'assets', 'merit-certificate-template.png'),
      path.resolve(process.cwd(), 'backend', 'assets', 'merit-certificate-template.jpg'),
      path.resolve(process.cwd(), 'backend', 'assets', 'merit-certificate-template.jpeg'),
      path.resolve(process.cwd(), 'backend', 'assets', 'merit-certificate-template.png'),
      path.resolve(__dirname, '../../..', 'backend', 'assets', 'merit-certificate-template.jpg'),
      path.resolve(__dirname, '../../..', 'backend', 'assets', 'merit-certificate-template.jpeg'),
      path.resolve(__dirname, '../../..', 'backend', 'assets', 'merit-certificate-template.png'),
      path.resolve(__dirname, '../../..', 'frontend', 'public', 'merit-certificate-template.jpg'),
      path.resolve(__dirname, '../../..', 'frontend', 'public', 'merit-certificate-template.jpeg'),
      path.resolve(__dirname, '../../..', 'frontend', 'public', 'merit-certificate-template.png'),
      path.resolve(__dirname, '../../..', 'backend', 'uploads', 'players', 'profileImage', '270e56b1-67a4-4fb6-91bb-f15a995bc701', 'Certificate-1.jpeg'),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch (_) {
        // ignore
      }
    }
    return null;
  };

  const templatePath = resolveMeritCertificateTemplatePath();
  res.setHeader('X-Merit-Template', templatePath ? '1' : '0');
  if (templatePath) {
    try {
      doc.image(templatePath, 0, 0, { width: pageW, height: pageH });
    } catch (_) {
      // ignore
    }

    const parseNum = (v) => {
      if (v === undefined || v === null) return null;
      const n = Number(String(v).trim());
      return Number.isFinite(n) ? n : null;
    };

    const toAbs = (n, base) => {
      if (n === null || n === undefined) return null;
      return n <= 1 ? n * base : n;
    };

    const layout = {
      photo: {
        x: 0.80,
        y: 0.195,
        w: 0.15,
        h: 0.24,
        inset: -5,
      },
      name: {
        x: 0.24,
        y: 0.61,
        w: 0.62,
        fontSize: 13,
      },
      club: {
        x: 0.72,
        y: 0.613,
        w: 0.62,
        fontSize: 12,
      },
      dobDay: {
        x: 0.566,
        y: 0.613,
        w: 0.05,
        fontSize: 12,
      },
      dobMonth: {
        x: 0.60,
        y: 0.613,
        w: 0.05,
        fontSize: 12,
      },
      dobYear: {
        x: 0.635,
        y: 0.613,
        w: 0.08,
        fontSize: 12,
      },
    };

    {
      const q = req.query || {};
      const px = toAbs(parseNum(q.photoX), pageW);
      const py = toAbs(parseNum(q.photoY), pageH);
      const pw = toAbs(parseNum(q.photoW), pageW);
      const ph = toAbs(parseNum(q.photoH), pageH);
      const pi = parseNum(q.photoInset);
      const nx = toAbs(parseNum(q.nameX), pageW);
      const ny = toAbs(parseNum(q.nameY), pageH);
      const nw = toAbs(parseNum(q.nameW), pageW);
      const nf = parseNum(q.nameFontSize);
      const cx = toAbs(parseNum(q.clubX), pageW);
      const cy = toAbs(parseNum(q.clubY), pageH);
      const cw = toAbs(parseNum(q.clubW), pageW);
      const cf = parseNum(q.clubFontSize);
      const ddx = toAbs(parseNum(q.dobDayX), pageW);
      const ddy = toAbs(parseNum(q.dobDayY), pageH);
      const ddw = toAbs(parseNum(q.dobDayW), pageW);
      const ddf = parseNum(q.dobDayFontSize);
      const dmx = toAbs(parseNum(q.dobMonthX), pageW);
      const dmy = toAbs(parseNum(q.dobMonthY), pageH);
      const dmw = toAbs(parseNum(q.dobMonthW), pageW);
      const dmf = parseNum(q.dobMonthFontSize);
      const dyx = toAbs(parseNum(q.dobYearX), pageW);
      const dyy = toAbs(parseNum(q.dobYearY), pageH);
      const dyw = toAbs(parseNum(q.dobYearW), pageW);
      const dyf = parseNum(q.dobYearFontSize);

      if (px !== null) layout.photo.x = px / pageW;
      if (py !== null) layout.photo.y = py / pageH;
      if (pw !== null) layout.photo.w = pw / pageW;
      if (ph !== null) layout.photo.h = ph / pageH;
      if (pi !== null) layout.photo.inset = Math.max(0, Math.floor(pi));
      if (nx !== null) layout.name.x = nx / pageW;
      if (ny !== null) layout.name.y = ny / pageH;
      if (nw !== null) layout.name.w = nw / pageW;
      if (nf !== null) layout.name.fontSize = Math.max(8, Math.floor(nf));
      if (cx !== null) layout.club.x = cx / pageW;
      if (cy !== null) layout.club.y = cy / pageH;
      if (cw !== null) layout.club.w = cw / pageW;
      if (cf !== null) layout.club.fontSize = Math.max(8, Math.floor(cf));
      if (ddx !== null) layout.dobDay.x = ddx / pageW;
      if (ddy !== null) layout.dobDay.y = ddy / pageH;
      if (ddw !== null) layout.dobDay.w = ddw / pageW;
      if (ddf !== null) layout.dobDay.fontSize = Math.max(8, Math.floor(ddf));
      if (dmx !== null) layout.dobMonth.x = dmx / pageW;
      if (dmy !== null) layout.dobMonth.y = dmy / pageH;
      if (dmw !== null) layout.dobMonth.w = dmw / pageW;
      if (dmf !== null) layout.dobMonth.fontSize = Math.max(8, Math.floor(dmf));
      if (dyx !== null) layout.dobYear.x = dyx / pageW;
      if (dyy !== null) layout.dobYear.y = dyy / pageH;
      if (dyw !== null) layout.dobYear.w = dyw / pageW;
      if (dyf !== null) layout.dobYear.fontSize = Math.max(8, Math.floor(dyf));
    }

    const photoX = Math.floor(pageW * layout.photo.x);
    const photoY = Math.floor(pageH * layout.photo.y);
    const photoW = Math.floor(pageW * layout.photo.w);
    const photoH = Math.floor(pageH * layout.photo.h);
    const inset = Math.max(0, Math.floor(layout.photo.inset || 0));
    const innerX = photoX + inset;
    const innerY = photoY + inset;
    const innerW = Math.max(1, photoW - inset * 2);
    const innerH = Math.max(1, photoH - inset * 2);

    doc.save();
    doc.rect(photoX, photoY, photoW, photoH).fill('#ffffff');
    doc.rect(innerX, innerY, innerW, innerH).fill('#ffffff');
    doc.restore();

    const profilePath = resolveLocalImagePath(player.profileImage);
    if (profilePath) {
      try {
        doc.save();
        doc.rect(innerX, innerY, innerW, innerH).clip();
        doc.image(profilePath, innerX, innerY, { fit: [innerW, innerH], align: 'center', valign: 'center' });
        doc.restore();
      } catch (_) {
        // ignore
      }
    }

    doc.save();
    doc.lineWidth(1).strokeColor('#9ca3af');
    doc.rect(photoX, photoY, photoW, photoH).stroke();
    doc.restore();

    const nameX = Math.floor(pageW * layout.name.x);
    const nameY = Math.floor(pageH * layout.name.y);
    const nameW = Math.floor(pageW * layout.name.w);
    doc.font('Helvetica-Bold').fontSize(layout.name.fontSize).fillColor('#111827');
    doc.text(playerName || '-', nameX, nameY, {
      width: nameW,
      align: 'left',
    });

    const clubX = Math.floor(pageW * layout.club.x);
    const clubY = Math.floor(pageH * layout.club.y);
    const clubW = Math.floor(pageW * layout.club.w);
    doc.font('Helvetica-Bold').fontSize(layout.club.fontSize).fillColor('#111827');
    doc.text(String(club?.clubName || '-'), clubX, clubY, {
      width: clubW,
      align: 'left',
    });

    let dobDayText = '-';
    let dobMonthText = '-';
    let dobYearText = '-';
    if (player.dateOfBirth) {
      try {
        const dt = new Date(player.dateOfBirth);
        if (!Number.isNaN(dt.getTime())) {
          dobDayText = String(dt.getDate()).padStart(2, '0');
          dobMonthText = String(dt.getMonth() + 1).padStart(2, '0');
          dobYearText = String(dt.getFullYear());
        }
      } catch (_) {
        // ignore
      }
    }

    const dobDayX = Math.floor(pageW * layout.dobDay.x);
    const dobDayY = Math.floor(pageH * layout.dobDay.y);
    const dobDayW = Math.floor(pageW * layout.dobDay.w);
    doc.font('Helvetica-Bold').fontSize(layout.dobDay.fontSize).fillColor('#111827');
    doc.text(dobDayText, dobDayX, dobDayY, { width: dobDayW, align: 'left' });

    const dobMonthX = Math.floor(pageW * layout.dobMonth.x);
    const dobMonthY = Math.floor(pageH * layout.dobMonth.y);
    const dobMonthW = Math.floor(pageW * layout.dobMonth.w);
    doc.font('Helvetica-Bold').fontSize(layout.dobMonth.fontSize).fillColor('#111827');
    doc.text(dobMonthText, dobMonthX, dobMonthY, { width: dobMonthW, align: 'left' });

    const dobYearX = Math.floor(pageW * layout.dobYear.x);
    const dobYearY = Math.floor(pageH * layout.dobYear.y);
    const dobYearW = Math.floor(pageW * layout.dobYear.w);
    doc.font('Helvetica-Bold').fontSize(layout.dobYear.fontSize).fillColor('#111827');
    doc.text(dobYearText, dobYearX, dobYearY, { width: dobYearW, align: 'left' });

    if (String(req.query?.debug || '').trim() === '1') {
      doc.save();
      doc.lineWidth(1).strokeColor('#ef4444');
      doc.rect(photoX, photoY, photoW, photoH).stroke();
      doc.strokeColor('#3b82f6');
      doc.rect(nameX, nameY, nameW, 26).stroke();
      doc.strokeColor('#22c55e');
      doc.rect(clubX, clubY, clubW, 20).stroke();
      doc.strokeColor('#a855f7');
      doc.rect(dobDayX, dobDayY, dobDayW, 20).stroke();
      doc.rect(dobMonthX, dobMonthY, dobMonthW, 20).stroke();
      doc.rect(dobYearX, dobYearY, dobYearW, 20).stroke();
      doc.restore();
    }
  } else {
    doc.rect(left, top, contentW, bottom - top).lineWidth(2).stroke('#111827');
    doc.rect(left + 10, top + 10, contentW - 20, bottom - top - 20).lineWidth(1).stroke('#111827');

    const logoPath = resolveTDKALogoPath();
    if (logoPath) {
      try {
        doc.image(logoPath, left + 18, top + 16, { fit: [70, 70] });
      } catch (_) {
        // ignore
      }
    }

    doc
      .font('Helvetica-Bold')
      .fontSize(24)
      .fillColor('#111827')
      .text('THANE DISTRICT KABADDI ASSOCIATION', left, top + 28, { width: contentW, align: 'center' });

    doc
      .font('Helvetica-Bold')
      .fontSize(28)
      .fillColor('#7c2d12')
      .text('MERIT CERTIFICATE', left, top + 80, { width: contentW, align: 'center' });

    const photoBoxW = 120;
    const photoBoxH = 120;
    const photoX = right - photoBoxW - 24;
    const photoY = top + 24;
    doc.rect(photoX, photoY, photoBoxW, photoBoxH).lineWidth(1).stroke('#111827');
    const imgPath = resolveLocalImagePath(player.profileImage);
    if (imgPath) {
      try {
        doc.image(imgPath, photoX + 6, photoY + 6, { fit: [photoBoxW - 12, photoBoxH - 12], align: 'center', valign: 'center' });
      } catch (_) {
        // ignore
      }
    }

    const midY = top + 170;
    doc.font('Helvetica').fontSize(14).fillColor('#111827');
    doc.text('This is to certify that', left + 40, midY);
    doc.font('Helvetica-Bold').fontSize(18).text(playerName || '-', left + 220, midY - 2);

    const line1 = `from club "${String(club?.clubName || '-')}" has participated in the competition`;
    doc.font('Helvetica').fontSize(14).text(line1, left + 40, midY + 28);
    doc.font('Helvetica-Bold').fontSize(16).text(`"${competition.competitionName}"`, left + 40, midY + 54);

    const periodLine = `Competition Period: ${formatDateDMY(competition.fromDate)} to ${formatDateDMY(competition.toDate)}`;
    doc.font('Helvetica').fontSize(12).text(periodLine, left + 40, midY + 82);

    const uid = player.uniqueIdNumber ? String(player.uniqueIdNumber) : '-';
    const dob = player.dateOfBirth ? formatDateDMY(player.dateOfBirth) : '-';
    doc.font('Helvetica').fontSize(12).text(`Membership/Unique ID: ${uid}`, left + 40, midY + 110);
    doc.font('Helvetica').fontSize(12).text(`Date of Birth: ${dob}`, left + 40, midY + 132);

    const signY = bottom - 90;
    const colW = contentW / 3;
    doc.font('Helvetica').fontSize(12);
    doc.text('Secretary', left + 20, signY, { width: colW, align: 'center' });
    doc.text('President', left + colW + 20, signY, { width: colW, align: 'center' });
    doc.text('Coach/Manager', left + 2 * colW + 20, signY, { width: colW, align: 'center' });
  }

  doc.end();
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
  generateMeritCertificatePDF,
  getClubPlayersInCompetition,
  setCaptain,
  getCompetitionClubInfo,
  updateCompetitionClubInfo,
  getObserverForCompetition,
  updateObserverForCompetition,
  setObserverForCompetition,
  // Referee management
  setRefereeForCompetition,
  getRefereeForCompetition,
  updateRefereeForCompetition,
};
