const createError = require("http-errors");
const prisma = require("../config/db");
const validateRequest = require("../utils/validateRequest");
const { z } = require("zod");

// Get all regions with filtering, pagination, and sorting
const getRegions = async (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;
  const search = req.query.search || "";
  const sortBy = req.query.sortBy || "number";
  const sortOrder = req.query.sortOrder === "desc" ? "desc" : "asc";

  const whereClause = {
    OR: [
      { regionName: { contains: search } },
      { abbreviation: { contains: search } },
    ],
  };

  try {
    const regions = await prisma.region.findMany({
      where: whereClause,
      skip: skip,
      take: limit,
      orderBy: { [sortBy]: sortOrder },
    });

    const totalRegions = await prisma.region.count({
      where: whereClause,
    });
    const totalPages = Math.ceil(totalRegions / limit);

    res.json({
      regions,
      page,
      totalPages,
      totalRegions,
    });
  } catch (error) {
    next(error);
  }
};

// Get a region by ID
const getRegionById = async (req, res, next) => {
  try {
    const region = await prisma.region.findUnique({
      where: { id: parseInt(req.params.id) },
    });
    
    if (!region) {
      return res.status(404).json({
        errors: { message: "Region not found." },
      });
    }
    
    res.json(region);
  } catch (error) {
    next(error);
  }
};

// Create a new region
const createRegion = async (req, res, next) => {
  // Define Zod schema for region creation
  const schema = z.object({
    number: z
      .number()
      .int()
      .min(1, "Number must be at least 1")
      .max(99, "Number must be at most 99")
      .refine(
        async (number) => {
          const existing = await prisma.region.findFirst({
            where: { number },
          });
          return !existing;
        },
        {
          message: "A region with this number already exists.",
        }
      ),
    abbreviation: z
      .string()
      .min(1, "Abbreviation cannot be left blank.")
      .max(10, "Abbreviation must not exceed 10 characters.")
      .regex(/^[A-Z]+$/, "Abbreviation must contain only uppercase letters.")
      .refine(
        async (abbreviation) => {
          const existing = await prisma.region.findFirst({
            where: { abbreviation },
          });
          return !existing;
        },
        {
          message: "A region with this abbreviation already exists.",
        }
      ),
    regionName: z
      .string()
      .min(1, "Region name cannot be left blank.")
      .max(100, "Region name must not exceed 100 characters.")
      .refine((val) => /^[A-Za-z\s\u0900-\u097F]+$/.test(val), {
        message: "Region name can only contain letters and spaces.",
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
    const region = await prisma.region.create({
      data: {
        number: req.body.number,
        abbreviation: req.body.abbreviation.toUpperCase(),
        regionName: req.body.regionName,
      },
    });

    res.status(201).json(region);
  } catch (error) {
    next(error);
  }
};

// Update a region
const updateRegion = async (req, res, next) => {
  const regionId = parseInt(req.params.id);
  
  // Define Zod schema for region update
  const schema = z.object({
    number: z
      .number()
      .int()
      .min(1, "Number must be at least 1")
      .max(99, "Number must be at most 99")
      .optional()
      .superRefine(async (number, ctx) => {
        if (number) {
          const existing = await prisma.region.findFirst({
            where: { 
              number,
              NOT: { id: regionId }
            },
          });
          if (existing) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "A region with this number already exists.",
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
          const existing = await prisma.region.findFirst({
            where: { 
              abbreviation,
              NOT: { id: regionId }
            },
          });
          if (existing) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "A region with this abbreviation already exists.",
            });
            return false;
          }
        }
        return true;
      }),
    regionName: z
      .string()
      .min(1, "Region name cannot be left blank.")
      .max(100, "Region name must not exceed 100 characters.")
      .refine((val) => /^[A-Za-z\s\u0900-\u097F]+$/.test(val), {
        message: "Region name can only contain letters and spaces.",
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
    // Check if the region exists
    const existingRegion = await prisma.region.findUnique({
      where: { id: regionId },
    });

    if (!existingRegion) {
      return res.status(404).json({
        errors: { message: "Region not found." },
      });
    }

    // Prepare update data
    const updateData = {};
    if (req.body.number !== undefined) updateData.number = req.body.number;
    if (req.body.abbreviation !== undefined) updateData.abbreviation = req.body.abbreviation.toUpperCase();
    if (req.body.regionName !== undefined) updateData.regionName = req.body.regionName;

    const region = await prisma.region.update({
      where: { id: regionId },
      data: updateData,
    });

    res.json(region);
  } catch (error) {
    next(error);
  }
};

// Delete a region
const deleteRegion = async (req, res, next) => {
  try {
    const region = await prisma.region.findUnique({
      where: { id: parseInt(req.params.id) },
    });

    if (!region) {
      return res.status(404).json({
        errors: { message: "Region not found." },
      });
    }

    await prisma.region.delete({
      where: { id: parseInt(req.params.id) },
    });

    res.json({ message: "Region deleted successfully." });
  } catch (error) {
    // Handle foreign key constraint violations gracefully (e.g., Places/Clubs linked)
    if (error && error.code === "P2003") {
      return res.status(409).json({
        errors: {
          message:
            "Cannot delete this region because places or clubs are linked to it. Reassign or remove the linked clubs (and then places), then try again.",
        },
      });
    }
    return next(error);
  }
};

module.exports = {
  getRegions,
  getRegionById,
  createRegion,
  updateRegion,
  deleteRegion,
};
