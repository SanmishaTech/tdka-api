const createError = require("http-errors");
const prisma = require("../config/db");
const validateRequest = require("../utils/validateRequest");
const { z } = require("zod");

// Get all talukas with filtering, pagination, and sorting
const getTalukas = async (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;
  const search = req.query.search || "";
  const sortBy = req.query.sortBy || "number";
  const sortOrder = req.query.sortOrder === "desc" ? "desc" : "asc";

  const whereClause = {
    OR: [
      { talukaName: { contains: search } },
      { abbreviation: { contains: search } },
    ],
  };

  try {
    const talukas = await prisma.taluka.findMany({
      where: whereClause,
      skip: skip,
      take: limit,
      orderBy: { [sortBy]: sortOrder },
    });

    const totalTalukas = await prisma.taluka.count({
      where: whereClause,
    });
    const totalPages = Math.ceil(totalTalukas / limit);

    res.json({
      talukas,
      page,
      totalPages,
      totalTalukas,
    });
  } catch (error) {
    next(error);
  }
};

// Get a taluka by ID
const getTalukaById = async (req, res, next) => {
  try {
    const taluka = await prisma.taluka.findUnique({
      where: { id: parseInt(req.params.id) },
    });
    
    if (!taluka) {
      return res.status(404).json({
        errors: { message: "Taluka not found." },
      });
    }
    
    res.json(taluka);
  } catch (error) {
    next(error);
  }
};

// Create a new taluka
const createTaluka = async (req, res, next) => {
  // Define Zod schema for taluka creation
  const schema = z.object({
    number: z
      .number()
      .int()
      .min(1, "Number must be at least 1")
      .max(99, "Number must be at most 99")
      .refine(
        async (number) => {
          const existing = await prisma.taluka.findFirst({
            where: { number },
          });
          return !existing;
        },
        {
          message: "A taluka with this number already exists.",
        }
      ),
    abbreviation: z
      .string()
      .min(1, "Abbreviation cannot be left blank.")
      .max(10, "Abbreviation must not exceed 10 characters.")
      .regex(/^[A-Z]+$/, "Abbreviation must contain only uppercase letters.")
      .refine(
        async (abbreviation) => {
          const existing = await prisma.taluka.findFirst({
            where: { abbreviation },
          });
          return !existing;
        },
        {
          message: "A taluka with this abbreviation already exists.",
        }
      ),
    talukaName: z
      .string()
      .min(1, "Taluka name cannot be left blank.")
      .max(100, "Taluka name must not exceed 100 characters.")
      .refine((val) => /^[A-Za-z\s\u0900-\u097F]+$/.test(val), {
        message: "Taluka name can only contain letters and spaces.",
      }),
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
    const taluka = await prisma.taluka.create({
      data: {
        number: req.body.number,
        abbreviation: req.body.abbreviation.toUpperCase(),
        talukaName: req.body.talukaName,
      },
    });

    res.status(201).json(taluka);
  } catch (error) {
    next(error);
  }
};

// Update a taluka
const updateTaluka = async (req, res, next) => {
  const talukaId = parseInt(req.params.id);
  
  // Define Zod schema for taluka update
  const schema = z.object({
    number: z
      .number()
      .int()
      .min(1, "Number must be at least 1")
      .max(99, "Number must be at most 99")
      .optional()
      .superRefine(async (number, ctx) => {
        if (number) {
          const existing = await prisma.taluka.findFirst({
            where: { 
              number,
              NOT: { id: talukaId }
            },
          });
          if (existing) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "A taluka with this number already exists.",
            });
            return false;
          }
        }
        return true;
      }),
    abbreviation: z
      .string()
      .min(1, "Abbreviation cannot be left blank.")
      .max(10, "Abbreviation must not exceed 10 characters.")
      .regex(/^[A-Z]+$/, "Abbreviation must contain only uppercase letters.")
      .optional()
      .superRefine(async (abbreviation, ctx) => {
        if (abbreviation) {
          const existing = await prisma.taluka.findFirst({
            where: { 
              abbreviation,
              NOT: { id: talukaId }
            },
          });
          if (existing) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "A taluka with this abbreviation already exists.",
            });
            return false;
          }
        }
        return true;
      }),
    talukaName: z
      .string()
      .min(1, "Taluka name cannot be left blank.")
      .max(100, "Taluka name must not exceed 100 characters.")
      .refine((val) => /^[A-Za-z\s\u0900-\u097F]+$/.test(val), {
        message: "Taluka name can only contain letters and spaces.",
      })
      .optional(),
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
    // Check if the taluka exists
    const existingTaluka = await prisma.taluka.findUnique({
      where: { id: talukaId },
    });

    if (!existingTaluka) {
      return res.status(404).json({
        errors: { message: "Taluka not found." },
      });
    }

    // Prepare update data
    const updateData = {};
    if (req.body.number !== undefined) updateData.number = req.body.number;
    if (req.body.abbreviation !== undefined) updateData.abbreviation = req.body.abbreviation.toUpperCase();
    if (req.body.talukaName !== undefined) updateData.talukaName = req.body.talukaName;

    const taluka = await prisma.taluka.update({
      where: { id: talukaId },
      data: updateData,
    });

    res.json(taluka);
  } catch (error) {
    next(error);
  }
};

// Delete a taluka
const deleteTaluka = async (req, res, next) => {
  try {
    const taluka = await prisma.taluka.findUnique({
      where: { id: parseInt(req.params.id) },
    });

    if (!taluka) {
      return res.status(404).json({
        errors: { message: "Taluka not found." },
      });
    }

    await prisma.taluka.delete({
      where: { id: parseInt(req.params.id) },
    });

    res.json({ message: "Taluka deleted successfully." });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getTalukas,
  getTalukaById,
  createTaluka,
  updateTaluka,
  deleteTaluka,
};
