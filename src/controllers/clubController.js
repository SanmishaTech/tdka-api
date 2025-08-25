const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient();
const { z } = require("zod");
const createError = require("http-errors");
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


const getClubs = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.max(1, parseInt(req.query.limit) || 10);
  const skip = (page - 1) * limit;

  const { search = "", sortBy = "clubName", sortOrder = "asc" } = req.query;

  // Map frontend sort field "name" to database column "clubName"
  const mappedSortBy = sortBy === "name" ? "clubName" : sortBy;

  const where = search
    ? {
        OR: [
          { clubName: { contains: search } },
          { city: { contains: search } },
          { address: { contains: search } },
          { affiliationNumber: { contains: search } },
        ],
      }
    : {};

  const [clubs, total] = await Promise.all([
    prisma.club.findMany({
      where,
      skip,
      take: limit,
      orderBy: { [mappedSortBy]: sortOrder },
      select: {
        id: true,
        clubName: true,
        affiliationNumber: true,
        uniqueNumber: true,
        regionId: true,
        city: true,
        address: true,
        mobile: true,
        email: true,
        
        // President details
        presidentName: true,
        presidentMobile: true,
        presidentEmail: true,
        presidentAadhar: true,
        
        // Secretary details
        secretaryName: true,
        secretaryMobile: true,
        secretaryEmail: true,
        secretaryAadhar: true,
        
        // Treasurer details
        treasurerName: true,
        treasurerMobile: true,
        treasurerEmail: true,
        treasurerAadhar: true,
        
        // Coach details
        coachName: true,
        coachMobile: true,
        coachEmail: true,
        coachAadhar: true,
        
        // Manager details
        managerName: true,
        managerMobile: true,
        managerEmail: true,
        managerAadhar: true,
        
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.club.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  res.json({
    clubs,
    page,
    totalPages,
    totalClubs: total,
  });
});

const getClub = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) throw createError(400, "Invalid club ID");

  const club = await prisma.club.findUnique({
    where: { id },
    select: {
      id: true,
      clubName: true,
      affiliationNumber: true,
      uniqueNumber: true,
      regionId: true,
      city: true,
      address: true,
      mobile: true,
      email: true,
      
      // President details
      presidentName: true,
      presidentMobile: true,
      presidentEmail: true,
      presidentAadhar: true,
      
      // Secretary details
      secretaryName: true,
      secretaryMobile: true,
      secretaryEmail: true,
      secretaryAadhar: true,
      
      // Treasurer details
      treasurerName: true,
      treasurerMobile: true,
      treasurerEmail: true,
      treasurerAadhar: true,
      
      // Coach details
      coachName: true,
      coachMobile: true,
      coachEmail: true,
      coachAadhar: true,
      
      // Manager details
      managerName: true,
      managerMobile: true,
      managerEmail: true,
      managerAadhar: true,
      
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!club) throw createError(404, "Club not found");

  res.json(club);
});

const createClub = asyncHandler(async (req, res) => {
  const schema = z.object({
    clubName: z.string().min(1, "Club name is required").max(255),
    affiliationNumber: z.string().max(255).optional(),
    regionId: z.number().int().min(1, "Please select a region"),
    city: z.string().max(255).optional(),
    address: z.string().min(1, "Address is required").max(500),
    mobile: z.string().min(1, "Mobile number is required").max(20),
    email: z.string().email("Valid email is required").max(255),
    password: z.string().min(6, "Password must be at least 6 characters").max(255),
    role: z.string().default("clubadmin"),
    
    // President details (optional for backward compatibility)
    presidentName: z.string().max(255).optional(),
    presidentMobile: z.string().max(20).optional(),
    presidentEmail: z.string().email("Valid president email is required").max(255).optional(),
    presidentAadhar: z.string().max(12).optional(),
    
    // Secretary details (optional for backward compatibility)
    secretaryName: z.string().max(255).optional(),
    secretaryMobile: z.string().max(20).optional(),
    secretaryEmail: z.string().email("Valid secretary email is required").max(255).optional(),
    secretaryAadhar: z.string().max(12).optional(),
    
    // Treasurer details (optional for backward compatibility)
    treasurerName: z.string().max(255).optional(),
    treasurerMobile: z.string().max(20).optional(),
    treasurerEmail: z.string().email("Valid treasurer email is required").max(255).optional(),
    treasurerAadhar: z.string().max(12).optional(),
    
    // Coach details (optional)
    coachName: z.string().max(255).optional(),
    coachMobile: z.string().max(20).optional(),
    coachEmail: z.string().email("Valid coach email is required").max(255).optional(),
    coachAadhar: z.string().max(12).optional(),
    
    // Manager details (optional)
    managerName: z.string().max(255).optional(),
    managerMobile: z.string().max(20).optional(),
    managerEmail: z.string().email("Valid manager email is required").max(255).optional(),
    managerAadhar: z.string().max(12).optional(),
  });

  // Preprocess data: convert empty strings to undefined for proper optional handling
  const preprocessedCreateData = {};
  Object.keys(req.body || {}).forEach(key => {
    const value = req.body[key];
    preprocessedCreateData[key] = (typeof value === 'string' && value.trim() === '') ? undefined : value;
  });

  // Will throw Zod errors caught by asyncHandler
  const validatedData = await schema.parseAsync(preprocessedCreateData);

  // Validate that the region exists
  const region = await prisma.region.findUnique({
    where: { id: validatedData.regionId },
    include: { taluka: true }
  });
  
  if (!region) {
    throw createError(400, "Selected region does not exist");
  }

  // Hash the password before saving
  const hashedPassword = await bcrypt.hash(validatedData.password, 10);

  // Start a transaction to create both club and user
  const result = await prisma.$transaction(async (prisma) => {
    // Generate unique club number
    const clubCount = await prisma.club.count({
      where: { regionId: validatedData.regionId }
    });
    const clubNumber = (clubCount + 1).toString().padStart(2, '0');
    const uniqueNumber = `TDKA/${region.abbreviation}/TDKA${clubNumber}`;

    // Create the club
    const club = await prisma.club.create({
      data: {
        clubName: validatedData.clubName,
        affiliationNumber: validatedData.affiliationNumber ?? "",
        uniqueNumber: uniqueNumber,
        regionId: validatedData.regionId,
        city: validatedData.city ?? "",
        address: validatedData.address,
        mobile: validatedData.mobile,
        email: validatedData.email,
        password: hashedPassword,
        
        // President details
        presidentName: validatedData.presidentName,
        presidentMobile: validatedData.presidentMobile,
        presidentEmail: validatedData.presidentEmail,
        presidentAadhar: validatedData.presidentAadhar,
        
        // Secretary details
        secretaryName: validatedData.secretaryName,
        secretaryMobile: validatedData.secretaryMobile,
        secretaryEmail: validatedData.secretaryEmail,
        secretaryAadhar: validatedData.secretaryAadhar,
        
        // Treasurer details
        treasurerName: validatedData.treasurerName,
        treasurerMobile: validatedData.treasurerMobile,
        treasurerEmail: validatedData.treasurerEmail,
        treasurerAadhar: validatedData.treasurerAadhar,
        
        // Coach details
        coachName: validatedData.coachName,
        coachMobile: validatedData.coachMobile,
        coachEmail: validatedData.coachEmail,
        coachAadhar: validatedData.coachAadhar,
        
        // Manager details
        managerName: validatedData.managerName,
        managerMobile: validatedData.managerMobile,
        managerEmail: validatedData.managerEmail,
        managerAadhar: validatedData.managerAadhar
      } 
    });
    
    // Create a user with clubadmin role and link to the club
    const user = await prisma.user.create({
      data: {
        name: validatedData.clubName, // Use club name as user name
        email: validatedData.email,
        password: hashedPassword,
        role: "clubadmin", // Set role as clubadmin
        active: true,
        clubId: club.id // Link the user to the club
      }
    });
    
    return { club, user };
  });

  // Return club without password
  const { password, ...clubResponse } = result.club;
  res.status(201).json(clubResponse);
});

const updateClub = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) throw createError(400, "Invalid club ID");

  const schema = z
    .object({
      clubName: z.string().min(1).max(255).optional(),
      affiliationNumber: z.string().min(1).max(255).optional(),
      city: z.string().min(1).max(255).optional(),
      address: z.string().min(1).max(500).optional(),
      mobile: z.string().min(1).max(20).optional(),
      email: z.string().email("Valid email is required").max(255).optional(),
      password: z.string().min(6, "Password must be at least 6 characters").max(255).optional().or(z.literal('')),
      role: z.string().optional(),
      
      // President details (optional for updates)
      presidentName: z.string().min(1).max(255).optional(),
      presidentMobile: z.string().min(1).max(20).optional(),
      presidentEmail: z.string().email("Valid president email is required").max(255).optional(),
      presidentAadhar: z.string().min(1).max(12).optional(),
      
      // Secretary details (optional for updates)
      secretaryName: z.string().min(1).max(255).optional(),
      secretaryMobile: z.string().min(1).max(20).optional(),
      secretaryEmail: z.string().email("Valid secretary email is required").max(255).optional(),
      secretaryAadhar: z.string().min(1).max(12).optional(),
      
      // Treasurer details (optional for updates)
      treasurerName: z.string().min(1).max(255).optional(),
      treasurerMobile: z.string().min(1).max(20).optional(),
      treasurerEmail: z.string().email("Valid treasurer email is required").max(255).optional(),
      treasurerAadhar: z.string().min(1).max(12).optional(),
      
      // Coach details (optional for updates)
      coachName: z.string().min(1).max(255).optional(),
      coachMobile: z.string().min(1).max(20).optional(),
      coachEmail: z.string().email("Valid coach email is required").max(255).optional(),
      coachAadhar: z.string().min(1).max(12).optional(),
      
      // Manager details (optional for updates)
      managerName: z.string().min(1).max(255).optional(),
      managerMobile: z.string().min(1).max(20).optional(),
      managerEmail: z.string().email("Valid manager email is required").max(255).optional(),
      managerAadhar: z.string().min(1).max(12).optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: "At least one field is required",
    });

  // Preprocess data: convert empty strings to undefined for proper optional handling
  const preprocessedData = {};
  Object.keys(req.body).forEach(key => {
    const value = req.body[key];
    preprocessedData[key] = (typeof value === 'string' && value.trim() === '') ? undefined : value;
  });

  const validatedData = await schema.parseAsync(preprocessedData);

  const existing = await prisma.club.findUnique({ where: { id } });
  if (!existing) throw createError(404, "Club not found");

  // If password is being updated, hash it
  let dataToUpdate = { ...validatedData };
  
  // Handle empty password - remove it from the update data
  if (dataToUpdate.password === '') {
    delete dataToUpdate.password;
  } else if (dataToUpdate.password) {
    dataToUpdate.password = await bcrypt.hash(dataToUpdate.password, 10);
  }

  // Remove undefined fields and role field (not in Club model) to prevent errors
  Object.keys(dataToUpdate).forEach(key => {
    if (dataToUpdate[key] === undefined || key === 'role') {
      delete dataToUpdate[key];
    }
  });

  const updated = await prisma.club.update({
    where: { id },
    data: dataToUpdate,
  });

  // If email, club name, or password is being updated, also update the corresponding user
  if (validatedData.email || validatedData.clubName || validatedData.password) {
    try {
      const user = await prisma.user.findFirst({
        where: { 
          email: existing.email,
          role: "clubadmin"
        }
      });
      
      if (user) {
        const userUpdateData = {};
        
        // If email is updated, update user email
        if (validatedData.email) {
          userUpdateData.email = validatedData.email;
        }
        
        // If club name is updated, update user name too
        if (validatedData.clubName) {
          userUpdateData.name = validatedData.clubName;
        }
        
        // If password is updated, update user password too
        if (validatedData.password) {
          userUpdateData.password = dataToUpdate.password; // Already hashed
        }
        
        // Ensure the user is linked to the club
        userUpdateData.clubId = id;
        
        await prisma.user.update({
          where: { id: user.id },
          data: userUpdateData
        });
      }
    } catch (error) {
      console.error("Failed to update associated user:", error);
      // Continue with the response even if user update fails
    }
  }

  // Return club without password
  const { password, ...clubResponse } = updated;
  res.json(clubResponse);
});

const deleteClub = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) throw createError(400, "Invalid club ID");

  const existing = await prisma.club.findUnique({ where: { id } });
  if (!existing) throw createError(404, "Club not found");

  await prisma.club.delete({ where: { id } });
  res.json({ message: "Club deleted successfully" });
});

// Get regions for dropdown
const getRegions = asyncHandler(async (req, res) => {
  const regions = await prisma.region.findMany({
    select: {
      id: true,
      regionName: true,
      abbreviation: true,
      number: true,
      taluka: {
        select: {
          id: true,
          talukaName: true,
          abbreviation: true,
          number: true
        }
      }
    },
    orderBy: [{ number: "asc" }]
  });
  
  res.json(regions);
});

module.exports = {
  getClubs,
  createClub,
  getClub,
  updateClub,
  deleteClub,
  getRegions,
};
