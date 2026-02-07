const createError = require("http-errors");
const prisma = require("../config/db");
const validateRequest = require("../utils/validateRequest");
const { z } = require("zod");

// Get all places with filtering, pagination, and sorting
const getPlaces = async (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;
  const search = req.query.search || "";
  const sortBy = req.query.sortBy || "number";
  const sortOrder = req.query.sortOrder === "desc" ? "desc" : "asc";

  const whereClause = {
    OR: [
      { placeName: { contains: search } },
      { abbreviation: { contains: search } },
    ],
  };

  try {
    const places = await prisma.place.findMany({
      where: whereClause,
      skip: skip,
      take: limit,
      orderBy: { [sortBy]: sortOrder },
      include: {
        region: {
          select: {
            id: true,
            regionName: true,
            abbreviation: true,
            number: true
          }
        }
      }
    });

    const totalPlaces = await prisma.place.count({
      where: whereClause,
    });
    const totalPages = Math.ceil(totalPlaces / limit);

    res.json({
      places,
      page,
      totalPages,
      totalPlaces,
    });
  } catch (error) {
    next(error);
  }
};

// Get a place by ID
const getPlaceById = async (req, res, next) => {
  try {
    const place = await prisma.place.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        region: {
          select: {
            id: true,
            regionName: true,
            abbreviation: true,
            number: true
          }
        }
      }
    });
    
    if (!place) {
      return res.status(404).json({
        errors: { message: "Place not found." },
      });
    }
    
    res.json(place);
  } catch (error) {
    next(error);
  }
};

// Create a new place
const createPlace = async (req, res, next) => {
  // Define Zod schema for place creation
  const schema = z.object({
    number: z
      .number()
      .int()
      .min(1, "Number must be at least 1")
      .max(99, "Number must be at most 99")
      .refine(
        async (number) => {
          const existing = await prisma.place.findFirst({
            where: { number },
          });
          return !existing;
        },
        {
          message: "A place with this number already exists.",
        }
      ),
    abbreviation: z
      .string()
      .min(1, "Abbreviation cannot be left blank.")
      .max(10, "Abbreviation must not exceed 10 characters.")
      .regex(/^[A-Z]+$/, "Abbreviation must contain only uppercase letters.")
      .refine(
        async (abbreviation) => {
          const existing = await prisma.place.findFirst({
            where: { abbreviation },
          });
          return !existing;
        },
        {
          message: "A place with this abbreviation already exists.",
        }
      ),
    placeName: z
      .string()
      .min(1, "Place name cannot be left blank.")
      .max(100, "Place name must not exceed 100 characters.")
      .refine((val) => /^[A-Za-z\s\u0900-\u097F]+$/.test(val), {
        message: "Place name can only contain letters and spaces.",
      }),
    regionId: z
      .number()
      .int()
      .min(1, "Region ID must be at least 1")
      .refine(
        async (regionId) => {
          const existing = await prisma.region.findUnique({
            where: { id: regionId },
          });
          return !!existing;
        },
        {
          message: "The specified region does not exist.",
        }
      ),
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
    const place = await prisma.place.create({
      data: {
        number: req.body.number,
        abbreviation: req.body.abbreviation.toUpperCase(),
        placeName: req.body.placeName,
        regionId: req.body.regionId,
      },
      include: {
        region: {
          select: {
            id: true,
            regionName: true,
            abbreviation: true,
            number: true
          }
        }
      }
    });

    res.status(201).json(place);
  } catch (error) {
    next(error);
  }
};

// Update a place
const updatePlace = async (req, res, next) => {
  const placeId = parseInt(req.params.id);
  
  // Define Zod schema for place update
  const schema = z.object({
    number: z
      .number()
      .int()
      .min(1, "Number must be at least 1")
      .max(99, "Number must be at most 99")
      .optional()
      .superRefine(async (number, ctx) => {
        if (number) {
          const existing = await prisma.place.findFirst({
            where: { 
              number,
              NOT: { id: placeId }
            },
          });
          if (existing) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "A place with this number already exists.",
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
          const existing = await prisma.place.findFirst({
            where: { 
              abbreviation,
              NOT: { id: placeId }
            },
          });
          if (existing) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "A place with this abbreviation already exists.",
            });
            return false;
          }
        }
        return true;
      }),
    placeName: z
      .string()
      .min(1, "Place name cannot be left blank.")
      .max(100, "Place name must not exceed 100 characters.")
      .refine((val) => /^[A-Za-z\s\u0900-\u097F]+$/.test(val), {
        message: "Place name can only contain letters and spaces.",
      })
      .optional(),
    regionId: z
      .number()
      .int()
      .min(1, "Region ID must be at least 1")
      .optional()
      .superRefine(async (regionId, ctx) => {
        if (regionId) {
          const existing = await prisma.region.findUnique({
            where: { id: regionId },
          });
          if (!existing) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "The specified region does not exist.",
            });
            return false;
          }
        }
        return true;
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
    // Check if the place exists
    const existingPlace = await prisma.place.findUnique({
      where: { id: placeId },
    });

    if (!existingPlace) {
      return res.status(404).json({
        errors: { message: "Place not found." },
      });
    }

    // Prepare update data
    const updateData = {};
    if (req.body.number !== undefined) updateData.number = req.body.number;
    if (req.body.abbreviation !== undefined) updateData.abbreviation = req.body.abbreviation.toUpperCase();
    if (req.body.placeName !== undefined) updateData.placeName = req.body.placeName;
    if (req.body.regionId !== undefined) updateData.regionId = req.body.regionId;

    const place = await prisma.place.update({
      where: { id: placeId },
      data: updateData,
      include: {
        region: {
          select: {
            id: true,
            regionName: true,
            abbreviation: true,
            number: true
          }
        }
      }
    });

    res.json(place);
  } catch (error) {
    next(error);
  }
};

// Delete a place
const deletePlace = async (req, res, next) => {
  try {
    const place = await prisma.place.findUnique({
      where: { id: parseInt(req.params.id) },
    });

    if (!place) {
      return res.status(404).json({
        errors: { message: "Place not found." },
      });
    }

    await prisma.place.delete({
      where: { id: parseInt(req.params.id) },
    });

    res.json({ message: "Place deleted successfully." });
  } catch (error) {
    // Handle foreign key constraint violations gracefully (e.g., Clubs linked)
    if (error && error.code === "P2003") {
      return res.status(409).json({
        errors: {
          message:
            "Cannot delete this place because clubs are linked to it. Reassign or remove the linked clubs, then try again.",
        },
      });
    }
    return next(error);
  }
};

// Get all regions for dropdown
const getRegions = async (req, res, next) => {
  try {
    const regions = await prisma.region.findMany({
      select: {
        id: true,
        regionName: true,
        abbreviation: true,
        number: true
      },
      orderBy: { number: "asc" }
    });
    
    res.json(regions);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getPlaces,
  getPlaceById,
  createPlace,
  updatePlace,
  deletePlace,
  getRegions,
};
