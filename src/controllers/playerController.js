const createError = require("http-errors");
const ExcelJS = require("exceljs");
const prisma = require("../config/db");
const validateRequest = require("../utils/validateRequest");
const aclService = require("../services/aclService");
const { z } = require("zod");

// Generate a unique ID number for players
const generateUniqueIdNumber = async () => {
  // Format: PLAYER-YYYYMMDD-XXXX where XXXX is a sequential number
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, "");
  
  // Get the count of players created today to generate sequential number
  const todayStart = new Date(today.setHours(0, 0, 0, 0));
  const todayEnd = new Date(today.setHours(23, 59, 59, 999));
  
  const todayPlayersCount = await prisma.player.count({
    where: {
      createdAt: {
        gte: todayStart,
        lte: todayEnd
      }
    }
  });
  
  // Format the sequential number with leading zeros
  const sequentialNumber = String(todayPlayersCount + 1).padStart(4, '0');
  return `PLAYER-${dateStr}-${sequentialNumber}`;
};

// Get all players with filtering, pagination, and optional export
const getPlayers = async (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;
  const search = req.query.search || "";
  const isSuspended = req.query.isSuspended === "true" ? true : 
                     req.query.isSuspended === "false" ? false : undefined;
  const aadharVerified = req.query.aadharVerified === "true" ? true : 
                        req.query.aadharVerified === "false" ? false : undefined;
  const sortBy = req.query.sortBy || "id";
  const sortOrder = req.query.sortOrder === "desc" ? "desc" : "asc";
  const exportToExcel = req.query.export === "true";

  // Check if the user has the 'players.export' permission using ACL service
  if (exportToExcel && !aclService.hasPermission(req.user, "players.export")) {
    return res.status(403).json({
      errors: { message: "You do not have permission to export players" },
    });
  }

  const whereClause = {
    AND: [
      {
        OR: [
          { firstName: { contains: search } },
          { lastName: { contains: search } },
          { uniqueIdNumber: { contains: search } },
          { aadharNumber: { contains: search } }
        ],
      },
      isSuspended !== undefined ? { isSuspended } : {},
      aadharVerified !== undefined ? { aadharVerified } : {},
    ],
  };

  try {
    const players = await prisma.player.findMany({
      where: whereClause,
      include: {
        groups: true,
      },
      skip: exportToExcel ? undefined : skip,
      take: exportToExcel ? undefined : limit,
      orderBy: { [sortBy]: sortOrder },
    });

    if (exportToExcel) {
      // Create a new workbook and worksheet
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Players");

      // Add headers
      worksheet.columns = [
        { header: "ID", key: "id", width: 10 },
        { header: "Unique ID", key: "uniqueIdNumber", width: 20 },
        { header: "First Name", key: "firstName", width: 20 },
        { header: "Middle Name", key: "middleName", width: 20 },
        { header: "Last Name", key: "lastName", width: 20 },
        { header: "Date of Birth", key: "dateOfBirth", width: 15 },
        { header: "Position", key: "position", width: 15 },
        { header: "Address", key: "address", width: 30 },
        { header: "Mobile", key: "mobile", width: 15 },
        { header: "Aadhar Number", key: "aadharNumber", width: 20 },
        { header: "Aadhar Verified", key: "aadharVerified", width: 15 },
        { header: "Suspended", key: "isSuspended", width: 15 },
        { header: "Groups", key: "groups", width: 30 },
      ];

      // Add rows
      players.forEach((player) => {
        worksheet.addRow({
          id: player.id,
          uniqueIdNumber: player.uniqueIdNumber,
          firstName: player.firstName,
          middleName: player.middleName || "",
          lastName: player.lastName,
          dateOfBirth: player.dateOfBirth.toISOString().split('T')[0],
          position: player.position || "",
          address: player.address,
          mobile: player.mobile,
          aadharNumber: player.aadharNumber,
          aadharVerified: player.aadharVerified ? "Yes" : "No",
          isSuspended: player.isSuspended ? "Yes" : "No",
          groups: player.groups.map(g => g.groupName).join(", ")
        });
      });

      // Set response headers for file download
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader("Content-Disposition", "attachment; filename=players.xlsx");

      // Write the workbook to the response
      await workbook.xlsx.write(res);
      return res.end();
    }

    const totalPlayers = await prisma.player.count({
      where: whereClause,
    });
    const totalPages = Math.ceil(totalPlayers / limit);

    res.json({
      players,
      page,
      totalPages,
      totalPlayers,
    });
  } catch (error) {
    next(error);
  }
};

// Get a player by ID
const getPlayerById = async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        groups: true,
      },
    });
    
    if (!player) {
      return res.status(404).json({
        errors: { message: "Player not found." },
      });
    }
    
    res.json(player);
  } catch (error) {
    next(error);
  }
};

// Create a new player
const createPlayer = async (req, res, next) => {
  // Define Zod schema for player creation
  const schema = z.object({
    firstName: z
      .string()
      .min(1, "First name cannot be left blank.")
      .max(100, "First name must not exceed 100 characters.")
      .refine((val) => /^[A-Za-z\s\u0900-\u097F]+$/.test(val), {
        message: "First name can only contain letters.",
      }),
    middleName: z
      .string()
      .max(100, "Middle name must not exceed 100 characters.")
      .refine((val) => !val || /^[A-Za-z\s\u0900-\u097F]+$/.test(val), {
        message: "Middle name can only contain letters.",
      })
      .optional()
      .nullable(),
    lastName: z
      .string()
      .min(1, "Last name cannot be left blank.")
      .max(100, "Last name must not exceed 100 characters.")
      .refine((val) => /^[A-Za-z\s\u0900-\u097F]+$/.test(val), {
        message: "Last name can only contain letters.",
      }),
    dateOfBirth: z.string().refine(
      (val) => {
        const date = new Date(val);
        return !isNaN(date.getTime());
      },
      {
        message: "Invalid date of birth.",
      }
    ),
    position: z.string().optional().nullable(),
    address: z.string().min(1, "Address cannot be left blank."),
    mobile: z
      .string()
      .min(10, "Mobile number must be at least 10 digits.")
      .max(15, "Mobile number must not exceed 15 digits.")
      .refine((val) => /^[0-9]+$/.test(val), {
        message: "Mobile number can only contain digits.",
      })
      .refine((val) => {
        // Indian mobile numbers should start with 6, 7, 8, or 9 (not 0)
        if (val.length === 10 && val.startsWith('0')) {
          return false;
        }
        return true;
      }, {
        message: "Invalid mobile number format. Indian mobile numbers should not start with 0.",
      }),
    aadharNumber: z
      .string()
      .length(12, "Aadhar number must be exactly 12 digits.")
      .refine((val) => /^\d+$/.test(val), {
        message: "Aadhar number can only contain digits.",
      })
      .refine(
        async (aadharNumber) => {
          const existing = await prisma.player.findFirst({
            where: { aadharNumber },
          });
          return !existing;
        },
        {
          message: "A player with this Aadhar number already exists.",
        }
      ),
    groupIds: z.union([
      z.array(z.number()),
      z.string().transform(val => {
        try {
          return JSON.parse(val);
        } catch (e) {
          return [];
        }
      })
    ]).optional(),
  });

  // Validate the request body using Zod
  console.log("Request body for player creation:", req.body);
  try {
    await schema.parseAsync(req.body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = {};
      error.errors.forEach((err) => {
        errors[err.path[0]] = {
          type: "validation",
          message: err.message,
        };
      });
      return res.status(400).json({ errors });
    }
    throw error;
  }

  try {
    // Generate unique ID number
    const uniqueIdNumber = await generateUniqueIdNumber();

    // Create player and connect groups
    console.log("Creating player with data:", {
      uniqueIdNumber,
      firstName: req.body.firstName,
      middleName: req.body.middleName || null,
      lastName: req.body.lastName,
      dateOfBirth: new Date(req.body.dateOfBirth),
      position: req.body.position || null,
      address: req.body.address,
      mobile: req.body.mobile,
      aadharNumber: req.body.aadharNumber,
      groupIds: req.body.groupIds
    });
    
    // Parse groupIds if it's a string (JSON)
    let groupIds = req.body.groupIds;
    if (typeof groupIds === 'string') {
      try {
        groupIds = JSON.parse(groupIds);
      } catch (e) {
        console.error("Error parsing groupIds:", e);
      }
    }
    
    const player = await prisma.player.create({
      data: {
        uniqueIdNumber,
        firstName: req.body.firstName,
        middleName: req.body.middleName || null,
        lastName: req.body.lastName,
        dateOfBirth: new Date(req.body.dateOfBirth),
        position: req.body.position || null,
        address: req.body.address,
        mobile: req.body.mobile,
        aadharNumber: req.body.aadharNumber,
        groups: groupIds && groupIds.length > 0 ? {
          connect: groupIds.map(id => ({ id: parseInt(id) }))
        } : undefined
      },
      include: {
        groups: true,
      },
    });

    res.status(201).json(player);
  } catch (error) {
    next(error);
  }
};

// Update a player
const updatePlayer = async (req, res, next) => {
  const playerId = parseInt(req.params.id);
  
  // Define Zod schema for player update
  const schema = z.object({
    firstName: z
      .string()
      .min(1, "First name cannot be left blank.")
      .max(100, "First name must not exceed 100 characters.")
      .refine((val) => /^[A-Za-z\s\u0900-\u097F]+$/.test(val), {
        message: "First name can only contain letters.",
      })
      .optional(),
    middleName: z
      .string()
      .max(100, "Middle name must not exceed 100 characters.")
      .refine((val) => !val || /^[A-Za-z\s\u0900-\u097F]+$/.test(val), {
        message: "Middle name can only contain letters.",
      })
      .optional()
      .nullable(),
    lastName: z
      .string()
      .min(1, "Last name cannot be left blank.")
      .max(100, "Last name must not exceed 100 characters.")
      .refine((val) => /^[A-Za-z\s\u0900-\u097F]+$/.test(val), {
        message: "Last name can only contain letters.",
      })
      .optional(),
    dateOfBirth: z.string().refine(
      (val) => {
        const date = new Date(val);
        return !isNaN(date.getTime());
      },
      {
        message: "Invalid date of birth.",
      }
    ).optional(),
    position: z.string().optional().nullable(),
    address: z.string().min(1, "Address cannot be left blank.").optional(),
    mobile: z
      .string()
      .min(10, "Mobile number must be at least 10 digits.")
      .max(15, "Mobile number must not exceed 15 digits.")
      .refine((val) => /^\d+$/.test(val), {
        message: "Mobile number can only contain digits.",
      })
      .optional(),
    aadharNumber: z
      .string()
      .length(12, "Aadhar number must be exactly 12 digits.")
      .refine((val) => /^\d+$/.test(val), {
        message: "Aadhar number can only contain digits.",
      })
      .optional()
      .superRefine(async (aadharNumber, ctx) => {
        if (aadharNumber) {
          const existing = await prisma.player.findFirst({
            where: { 
              aadharNumber,
              NOT: { id: playerId }
            },
          });
          if (existing) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "A player with this Aadhar number already exists.",
            });
            return false;
          }
        }
        return true;
      }),
    aadharVerified: z.boolean().optional(),
    groupIds: z.union([
      z.array(z.number()),
      z.string().transform(val => {
        try {
          return JSON.parse(val);
        } catch (e) {
          return [];
        }
      })
    ]).optional(),
  });

  // Validate the request body using Zod
  try {
    await schema.parseAsync(req.body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = {};
      error.errors.forEach((err) => {
        errors[err.path[0]] = {
          type: "validation",
          message: err.message,
        };
      });
      return res.status(400).json({ errors });
    }
    throw error;
  }

  try {
    // Get the existing player to check if it exists
    const existingPlayer = await prisma.player.findUnique({
      where: { id: playerId },
      include: { groups: true }
    });

    if (!existingPlayer) {
      return res.status(404).json({
        errors: { message: "Player not found." },
      });
    }

    // Prepare update data
    const updateData = {
      firstName: req.body.firstName,
      middleName: req.body.middleName,
      lastName: req.body.lastName,
      dateOfBirth: req.body.dateOfBirth ? new Date(req.body.dateOfBirth) : undefined,
      position: req.body.position,
      address: req.body.address,
      mobile: req.body.mobile,
      aadharNumber: req.body.aadharNumber,
      aadharVerified: req.body.aadharVerified,
    };

    // Remove undefined values
    Object.keys(updateData).forEach(key => 
      updateData[key] === undefined && delete updateData[key]
    );

    // Update player and connect/disconnect groups
    console.log("Updating player with data:", {
      ...updateData,
      groupIds: req.body.groupIds
    });
    
    // Parse groupIds if it's a string (JSON)
    let groupIds = req.body.groupIds;
    if (typeof groupIds === 'string') {
      try {
        groupIds = JSON.parse(groupIds);
      } catch (e) {
        console.error("Error parsing groupIds:", e);
      }
    }
    
    const player = await prisma.player.update({
      where: { id: playerId },
      data: {
        ...updateData,
        groups: groupIds && groupIds.length > 0 ? {
          set: [], // First disconnect all existing groups
          connect: groupIds.map(id => ({ id: parseInt(id) })) // Then connect the new ones
        } : undefined
      },
      include: {
        groups: true,
      },
    });

    res.json(player);
  } catch (error) {
    next(error);
  }
};

// Toggle player suspension status
const toggleSuspension = async (req, res, next) => {
  const schema = z.object({
    isSuspended: z.boolean({
      required_error: "Suspension status is required.",
      invalid_type_error: "Suspension status must be a boolean.",
    }),
  });

  // Validate the request body using Zod
  const validationResult = await validateRequest(schema, req.body);
  // Check if the result contains validation errors (objects with type and message properties)
  if (validationResult && typeof validationResult === 'object' && 
      Object.values(validationResult).some(val => val && typeof val === 'object' && val.type && val.message)) {
    return res.status(400).json({ errors: validationResult });
  }

  try {
    const updatedPlayer = await prisma.player.update({
      where: { id: parseInt(req.params.id) },
      data: { isSuspended: req.body.isSuspended },
      include: {
        groups: true,
      },
    });
    
    res.json(updatedPlayer);
  } catch (error) {
    if (error.code === "P2025") {
      return res.status(404).json({
        errors: { message: "Player not found" },
      });
    }
    next(error);
  }
};

// Toggle aadhar verification status
const toggleAadharVerification = async (req, res, next) => {
  const schema = z.object({
    aadharVerified: z.boolean({
      required_error: "Aadhar verification status is required.",
      invalid_type_error: "Aadhar verification status must be a boolean.",
    }),
  });

  // Validate the request body using Zod
  const validationResult = await validateRequest(schema, req.body);
  // Check if the result contains validation errors (objects with type and message properties)
  if (validationResult && typeof validationResult === 'object' && 
      Object.values(validationResult).some(val => val && typeof val === 'object' && val.type && val.message)) {
    return res.status(400).json({ errors: validationResult });
  }

  try {
    const updatedPlayer = await prisma.player.update({
      where: { id: parseInt(req.params.id) },
      data: { aadharVerified: req.body.aadharVerified },
      include: {
        groups: true,
      },
    });
    
    res.json(updatedPlayer);
  } catch (error) {
    if (error.code === "P2025") {
      return res.status(404).json({
        errors: { message: "Player not found" },
      });
    }
    next(error);
  }
};

module.exports = {
  getPlayers,
  getPlayerById,
  createPlayer,
  updatePlayer,
  toggleSuspension,
  toggleAadharVerification,
};