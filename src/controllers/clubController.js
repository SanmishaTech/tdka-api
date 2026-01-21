const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient();
const { z } = require("zod");
const createError = require("http-errors");
const bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");

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

  const {
    search = "",
    sortBy = "clubName",
    sortOrder = "asc",
    regionId,
    placeId,
  } = req.query;

  // Map frontend sort field "name" to database column "clubName"
  const mappedSortBy = sortBy === "name" ? "clubName" : sortBy;

  const where = search
    ? {
        OR: [
          { clubName: { contains: search } },
          { affiliationNumber: { contains: search } },
        ],
      }
    : {};

  if (placeId !== undefined && placeId !== "") {
    const parsedPlaceId = parseInt(placeId, 10);
    if (Number.isNaN(parsedPlaceId)) {
      throw createError(400, "Invalid placeId");
    }
    where.placeId = parsedPlaceId;
  }

  if (regionId !== undefined && regionId !== "") {
    const parsedRegionId = parseInt(regionId, 10);
    if (Number.isNaN(parsedRegionId)) {
      throw createError(400, "Invalid regionId");
    }
    where.place = { regionId: parsedRegionId };
  }

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
        placeId: true,
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
      placeId: true,
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
    placeId: z.number().int().min(1, "Please select a place"),
    city: z.string().max(255).optional(),
    address: z.string().max(500).optional(),
    mobile: z.string().max(20).optional(),
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
  Object.keys(req.body || {}).forEach((key) => {
    const value = req.body[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") {
        // Drop empty string fields entirely so optional schema fields are not validated
        return;
      }
      preprocessedCreateData[key] = value;
    } else {
      preprocessedCreateData[key] = value;
    }
  });
  // Coerce known numeric fields if they arrive as strings
  if (preprocessedCreateData.placeId !== undefined) {
    preprocessedCreateData.placeId = Number(preprocessedCreateData.placeId);
  }

  // Will throw Zod errors caught by asyncHandler
  const validatedData = await schema.parseAsync(preprocessedCreateData);

  // Validate that the place exists
  const place = await prisma.place.findUnique({
    where: { id: validatedData.placeId },
    include: { region: true }
  });
  
  if (!place) {
    throw createError(400, "Selected place does not exist");
  }

  // Hash the password before saving
  const hashedPassword = await bcrypt.hash(validatedData.password, 10);

  // Start a transaction to create both club and user
  const result = await prisma.$transaction(async (prisma) => {
    // Generate unique club number
    const clubCount = await prisma.club.count({
      where: { placeId: validatedData.placeId }
    });
    const clubNumber = (clubCount + 1).toString().padStart(2, '0');
    const uniqueNumber = `TDKA/${place.abbreviation}/TDKA${clubNumber}`;

    // Create the club
    const club = await prisma.club.create({
      data: {
        clubName: validatedData.clubName,
        affiliationNumber: validatedData.affiliationNumber ?? "",
        uniqueNumber: uniqueNumber,
        placeId: validatedData.placeId,
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
  Object.keys(req.body || {}).forEach((key) => {
    const value = req.body[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") {
        // Drop empty string fields entirely so optional schema fields are not validated
        return;
      }
      preprocessedData[key] = value;
    } else {
      preprocessedData[key] = value;
    }
  });
  // Coerce known numeric fields if they arrive as strings
  if (preprocessedData.placeId !== undefined) {
    preprocessedData.placeId = Number(preprocessedData.placeId);
  }

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

// Get places for dropdown
const getPlaces = asyncHandler(async (req, res) => {
  const places = await prisma.place.findMany({
    select: {
      id: true,
      placeName: true,
      abbreviation: true,
      number: true,
      region: {
        select: {
          id: true,
          regionName: true,
          abbreviation: true,
          number: true
        }
      }
    },
    orderBy: [{ number: "asc" }]
  });
  
  res.json(places);
});

// Import clubs from Excel
const importClubs = asyncHandler(async (req, res) => {
  try {
    // Handle upload validation errors from middleware
    if (req.uploadErrors && Object.keys(req.uploadErrors).length > 0) {
      return res.status(400).json({ errors: req.uploadErrors });
    }

    // Ensure file was uploaded
    const fileField = req.files && req.files.file;
    const uploadedFile = Array.isArray(fileField) && fileField.length > 0 ? fileField[0] : null;
    if (!uploadedFile) {
      return res.status(400).json({ errors: { file: [{ type: "required", message: "Excel file is required under field 'file'" }] } });
    }

    const filePath = uploadedFile.path;

    // Load workbook
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      return res.status(400).json({ errors: { file: [{ type: "invalid", message: "No worksheet found in Excel file" }] } });
    }

    // Helper: normalize ExcelJS cell value to a plain string (handles rich text and hyperlinks)
    const readCellStr = (cell) => {
      const v = cell?.value;
      if (v == null) return "";
      const t = typeof v;
      if (t === "string" || t === "number" || t === "boolean") return String(v).trim();
      if (t === "object") {
        // HyperlinkValue { text, hyperlink }
        if (typeof v.text === "string") return v.text.trim();
        // RichText { richText: [{ text }] }
        if (Array.isArray(v.richText)) return v.richText.map((r) => r?.text ?? "").join("").trim();
        // Formula result
        if (v.result != null) return String(v.result).trim();
      }
      return String(v).trim();
    };

    // Map headers to columns
    const headerMap = {};
    const headersRow = worksheet.getRow(1);
    headersRow.eachCell((cell, colNumber) => {
      const v = readCellStr(cell).toLowerCase();
      headerMap[v] = colNumber;
    });

    const requiredHeaders = ["club name", "place", "email"];
    const missingHeaders = requiredHeaders.filter((h) => !headerMap[h]);
    if (missingHeaders.length) {
      return res.status(400).json({ errors: { file: [{ type: "missing_headers", message: `Missing headers: ${missingHeaders.join(", ")}` }] } });
    }

    // Build place lookup (by placeName or abbreviation, case-insensitive)
    const places = await prisma.place.findMany({ select: { id: true, placeName: true, abbreviation: true } });
    const placeLookup = new Map();
    for (const p of places) {
      placeLookup.set(String(p.placeName).trim().toLowerCase(), p);
      placeLookup.set(String(p.abbreviation).trim().toLowerCase(), p);
    }

    // Prepare results
    const results = {
      rowsProcessed: 0,
      created: 0,
      errors: [],
    };

    const defaultPassword = "tdka@123";
    const hashedDefaultPassword = await bcrypt.hash(defaultPassword, 10);

    // Iterate rows starting from 2
    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
      const row = worksheet.getRow(rowNumber);
      if (!row || row.values?.length === 0) continue;

      results.rowsProcessed++;
      const clubName = readCellStr(row.getCell(headerMap["club name"]));
      const placeText = readCellStr(row.getCell(headerMap["place"]));
      const email = readCellStr(row.getCell(headerMap["email"]));

      // Basic validation
      const rowErrors = [];
      if (!clubName) rowErrors.push("Club Name is required");
      if (!placeText) rowErrors.push("Place is required");
      if (!email) rowErrors.push("Email is required");

      // Resolve place
      const place = placeText ? placeLookup.get(placeText.toLowerCase()) : null;
      if (!place) rowErrors.push(`Place not found: ${placeText}`);

      // Duplicate checks
      if (email) {
        const [existingClub, existingUser] = await Promise.all([
          prisma.club.findFirst({ where: { email } }),
          prisma.user.findUnique({ where: { email } }),
        ]);
        if (existingClub) rowErrors.push("A club with this email already exists");
        if (existingUser) rowErrors.push("A user with this email already exists");
      }

      if (rowErrors.length) {
        results.errors.push({ row: rowNumber, email, clubName, place: placeText, messages: rowErrors });
        continue;
      }

      // Create records in a transaction to ensure uniqueNumber generation and consistency
      try {
        await prisma.$transaction(async (tx) => {
          // Generate unique club number within place
          const clubCount = await tx.club.count({ where: { placeId: place.id } });
          const clubNumber = (clubCount + 1).toString().padStart(2, "0");
          const uniqueNumber = `TDKA/${place.abbreviation}/TDKA${clubNumber}`;

          const club = await tx.club.create({
            data: {
              clubName,
              affiliationNumber: "",
              uniqueNumber,
              placeId: place.id,
              city: "",
              address: "",
              mobile: "",
              email,
              password: hashedDefaultPassword,

              presidentName: null,
              presidentMobile: null,
              presidentEmail: null,
              presidentAadhar: null,
              secretaryName: null,
              secretaryMobile: null,
              secretaryEmail: null,
              secretaryAadhar: null,
              treasurerName: null,
              treasurerMobile: null,
              treasurerEmail: null,
              treasurerAadhar: null,
              coachName: null,
              coachMobile: null,
              coachEmail: null,
              coachAadhar: null,
              managerName: null,
              managerMobile: null,
              managerEmail: null,
              managerAadhar: null,
            },
          });

          await tx.user.create({
            data: {
              name: clubName,
              email,
              password: hashedDefaultPassword,
              role: "clubadmin",
              active: true,
              clubId: club.id,
            },
          });
        });
        results.created++;
      } catch (err) {
        console.error("Row import failed", { row: rowNumber, err });
        let message = "Failed to import row";
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          message = `Unique constraint violation on ${Array.isArray(err.meta?.target) ? err.meta.target.join(", ") : err.meta?.target}`;
        }
        results.errors.push({ row: rowNumber, email, clubName, place: placeText, messages: [message] });
      }
    }

    // Cleanup uploaded files
    if (req.cleanupUpload) {
      try {
        await req.cleanupUpload(req);
      } catch (cleanupErr) {
        console.error("Cleanup after import failed", cleanupErr);
      }
    }

    return res.json({
      summary: {
        rowsProcessed: results.rowsProcessed,
        created: results.created,
        errors: results.errors.length,
      },
      errors: results.errors,
    });
  } catch (error) {
    console.error("Import clubs error", error);
    // Attempt cleanup even on fatal error
    if (req && req.cleanupUpload) {
      try { await req.cleanupUpload(req); } catch {}
    }
    return res.status(500).json({ errors: { message: "Failed to import clubs" } });
  }
});

const exportClubs = asyncHandler(async (req, res) => {
  const {
    search = "",
    sortBy = "clubName",
    sortOrder = "asc",
    regionId,
    placeId,
  } = req.query;

  const mappedSortBy = sortBy === "name" ? "clubName" : sortBy;

  const where = search
    ? {
        OR: [
          { clubName: { contains: search } },
          { affiliationNumber: { contains: search } },
        ],
      }
    : {};

  if (placeId !== undefined && placeId !== "") {
    const parsedPlaceId = parseInt(placeId, 10);
    if (Number.isNaN(parsedPlaceId)) {
      throw createError(400, "Invalid placeId");
    }
    where.placeId = parsedPlaceId;
  }

  if (regionId !== undefined && regionId !== "") {
    const parsedRegionId = parseInt(regionId, 10);
    if (Number.isNaN(parsedRegionId)) {
      throw createError(400, "Invalid regionId");
    }
    where.place = { regionId: parsedRegionId };
  }

  const clubs = await prisma.club.findMany({
    where,
    orderBy: { [mappedSortBy]: sortOrder === "desc" ? "desc" : "asc" },
    select: {
      id: true,
      uniqueNumber: true,
      clubName: true,
      email: true,
      place: {
        select: {
          placeName: true,
          region: {
            select: {
              regionName: true,
            },
          },
        },
      },
    },
  });

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Clubs");
  worksheet.columns = [
    { header: "Unique Number", key: "uniqueNumber", width: 18 },
    { header: "Club Name", key: "clubName", width: 30 },
    { header: "Place", key: "place", width: 20 },
    { header: "Region", key: "region", width: 20 },
    { header: "Email", key: "email", width: 32 },
  ];

  clubs.forEach((c) => {
    worksheet.addRow({
      uniqueNumber: c.uniqueNumber || "",
      clubName: c.clubName || "",
      place: c.place?.placeName || "",
      region: c.place?.region?.regionName || "",
      email: c.email || "",
    });
  });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="TDKA_Clubs_Export.xlsx"'
  );

  await workbook.xlsx.write(res);
  res.end();
});

module.exports = {
  getClubs,
  createClub,
  getClub,
  updateClub,
  deleteClub,
  getPlaces,
  importClubs,
  exportClubs,
  downloadClubImportTemplate: asyncHandler(async (req, res) => {
    // Generate a simple Excel template with required headers
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Clubs");
    worksheet.columns = [
      { header: "Club Name", key: "clubName", width: 30 },
      { header: "Email", key: "email", width: 32 },
      { header: "Place", key: "place", width: 20 },
    ];

    // Optionally add a sample row (left blank to avoid accidental import)
    // worksheet.addRow({ clubName: "", email: "", region: "" });

    // Add a note row as comments in first row below headers (not required)
    // You can extend with a second sheet for instructions if needed

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="TDKA_Clubs_Import_Template.xlsx"'
    );

    await workbook.xlsx.write(res);
    res.end();
  }),
};
