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

const getGroups = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.max(1, parseInt(req.query.limit) || 10);
  const skip = (page - 1) * limit;

  const { search = "", sortBy = "groupName", sortOrder = "asc" } = req.query;

  // Map frontend sort field "name" to database column "groupName"
  const mappedSortBy = sortBy === "name" ? "groupName" : sortBy;

  const where = search
    ? {
        OR: [
          { groupName: { contains: search } },
          { gender: { contains: search } },
          { age: { contains: search } },
        ],
      }
    : {};

  // Try to access the model using lowercase 'group' as Prisma might have generated it that way
const prismaModel = prisma.group || prisma.Group;

if (!prismaModel) {
  throw new Error('Group model not found in Prisma client. Available models: ' + 
    Object.keys(prisma).filter(key => !key.startsWith('_')).join(', '));
}

const [groups, total] = await Promise.all([
  prismaModel.findMany({
    where,
    skip,
    take: limit,
    orderBy: { [mappedSortBy]: sortOrder },
    select: {
      id: true,
      groupName: true,
      gender: true,
      age: true,
      createdAt: true,
      updatedAt: true,
    },
  }),
  prismaModel.count({ where }),
]);

  const totalPages = Math.ceil(total / limit);

  res.json({
    groups,
    page,
    totalPages,
    totalGroups: total,
  });
});

const getGroup = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) throw createError(400, "Invalid group ID");

  const prismaModel = prisma.group || prisma.Group;
  if (!prismaModel) {
    throw new Error('Group model not found in Prisma client');
  }

  const group = await prismaModel.findUnique({
    where: { id },
    select: {
      id: true,
      groupName: true,
      gender: true,
      age: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!group) throw createError(404, "Group not found");

  res.json(group);
});

const createGroup = asyncHandler(async (req, res) => {
  const schema = z.object({
    groupName: z.string().min(1, "Group name is required").max(255),
    gender: z.enum(["Male", "Female", "Mix"], {
      errorMap: () => ({ message: "Gender must be Male, Female, or Mix" }),
    }),
    age: z.string().min(1, "Age limit is required").max(50),
  });

  // Will throw Zod errors caught by asyncHandler
  const validatedData = await schema.parseAsync(req.body);

  const prismaModel = prisma.group || prisma.Group;
  if (!prismaModel) {
    throw new Error('Group model not found in Prisma client');
  }

  const group = await prismaModel.create({ data: validatedData });

  res.status(201).json(group);
});

const updateGroup = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) throw createError(400, "Invalid group ID");

  const schema = z
    .object({
      groupName: z.string().min(1).max(255).optional(),
      gender: z.enum(["Male", "Female", "Mix"], {
        errorMap: () => ({ message: "Gender must be Male, Female, or Mix" }),
      }).optional(),
      age: z.string().min(1).max(50).optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: "At least one field is required",
    });

  const validatedData = await schema.parseAsync(req.body);

  const prismaModel = prisma.group || prisma.Group;
  if (!prismaModel) {
    throw new Error('Group model not found in Prisma client');
  }

  const existing = await prismaModel.findUnique({ where: { id } });
  if (!existing) throw createError(404, "Group not found");

  const updated = await prismaModel.update({
    where: { id },
    data: validatedData,
  });

  res.json(updated);
});

const deleteGroup = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) throw createError(400, "Invalid group ID");

  const prismaModel = prisma.group || prisma.Group;
  if (!prismaModel) {
    throw new Error('Group model not found in Prisma client');
  }

  const existing = await prismaModel.findUnique({ where: { id } });
  if (!existing) throw createError(404, "Group not found");

  await prismaModel.delete({ where: { id } });
  res.json({ message: "Group deleted successfully" });
});

module.exports = {
  getGroups,
  createGroup,
  getGroup,
  updateGroup,
  deleteGroup,
};