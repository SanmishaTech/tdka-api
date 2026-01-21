const { PrismaClient } = require("@prisma/client");
const asyncHandler = require("express-async-handler");
const createError = require("http-errors");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const prisma = new PrismaClient();

// ... rest of the code remains the same ...

const resolveClubIdFromReqUser = async (req) => {
  if (!req.user) return null;
  if (req.user.clubId) return req.user.clubId;
  if (req.user.role === "CLUB" && req.user.email) {
    const clubAdminUser = await prisma.user.findFirst({
      where: {
        email: req.user.email,
        role: "clubadmin",
      },
      select: { clubId: true },
    });
    return clubAdminUser?.clubId || null;
  }
  return null;
};

const parseGroupIds = (input) => {
  if (Array.isArray(input)) {
    return input
      .map((v) => parseInt(v, 10))
      .filter((v) => Number.isFinite(v) && v > 0);
  }

  if (typeof input === "string") {
    const s = input.trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) {
        return parsed
          .map((v) => parseInt(v, 10))
          .filter((v) => Number.isFinite(v) && v > 0);
      }
    } catch (_) {
      return s
        .split(",")
        .map((v) => parseInt(v.trim(), 10))
        .filter((v) => Number.isFinite(v) && v > 0);
    }
  }

  return [];
};

const hasUploadErrors = (req) => {
  if (!req.uploadErrors) return false;
  return Object.values(req.uploadErrors).some(
    (v) => Array.isArray(v) ? v.length > 0 : !!v
  );
};

const getUploadedFilePath = (req, fieldName) => {
  const f = req.files?.[fieldName]?.[0];
  if (!f || !f.path) return null;
  const rel = path.relative(process.cwd(), f.path);
  return rel.replace(/\\/g, "/");
};

const generateUniquePlayerIdNumber = async () => {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const prefix = `PLAYER-${yyyy}${mm}${dd}-`;

  const last = await prisma.player.findFirst({
    where: { uniqueIdNumber: { startsWith: prefix } },
    orderBy: { uniqueIdNumber: "desc" },
    select: { uniqueIdNumber: true },
  });

  const lastSeq = last?.uniqueIdNumber?.slice(prefix.length);
  const nextSeq = (parseInt(lastSeq || "0", 10) + 1).toString().padStart(4, "0");
  return `${prefix}${nextSeq}`;
};

const isBlankish = (v) => {
  if (v === undefined || v === null) return true;
  const s = String(v).trim();
  if (!s) return true;
  const lc = s.toLowerCase();
  return lc === "undefined" || lc === "null";
};

// Get all players with pagination and filtering
const getPlayers = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    search = "",
    clubId,
    isSuspended,
    aadharVerified,
    sortBy = "id",
    sortOrder = "asc",
    export: exportData = false,
  } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  // Build where clause
  const where = {};

  // Filter by club based on user role
  if (req.user) {
    if (req.user.role === "clubadmin" && req.user.clubId) {
      // Club admins can only see players from their club
      where.clubId = req.user.clubId;
    } else if (req.user.role === "CLUB") {
      // Direct club login - find the associated club admin user's clubId
      const clubAdminUser = await prisma.user.findFirst({
        where: {
          email: req.user.email,
          role: "clubadmin"
        }
      });
      if (clubAdminUser && clubAdminUser.clubId) {
        where.clubId = clubAdminUser.clubId;
      }
    }
    // Super admins and other roles can see all players (no clubId filter)
  }

  if (!isBlankish(clubId)) {
    const parsedClubId = parseInt(String(clubId), 10);
    if (Number.isNaN(parsedClubId)) {
      throw createError(400, "Invalid club ID");
    }
    if (!where.clubId) {
      where.clubId = parsedClubId;
    }
  }

  if (search) {
    where.OR = [
      { firstName: { contains: search } },
      { lastName: { contains: search } },
      { uniqueIdNumber: { contains: search } },
      { aadharNumber: { contains: search } },
    ];
  }

  if (isSuspended !== undefined) {
    where.isSuspended = isSuspended === "true";
  }

  if (aadharVerified !== undefined) {
    where.aadharVerified = aadharVerified === "true";
  }

  const orderBy = { [sortBy]: sortOrder };

  if (exportData === "true") {
    // Export all players to Excel
    const players = await prisma.player.findMany({
      where,
      include: {
        groups: true,
        club: true,
      },
      orderBy,
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Players");

    worksheet.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Unique ID", key: "uniqueIdNumber", width: 15 },
      { header: "First Name", key: "firstName", width: 15 },
      { header: "Middle Name", key: "middleName", width: 15 },
      { header: "Last Name", key: "lastName", width: 15 },
      { header: "Date of Birth", key: "dateOfBirth", width: 15 },
      { header: "Position", key: "position", width: 15 },
      { header: "Address", key: "address", width: 30 },
      { header: "Mobile", key: "mobile", width: 15 },
      { header: "Aadhar Number", key: "aadharNumber", width: 15 },
      { header: "Club", key: "club", width: 20 },
      { header: "Aadhar Verified", key: "aadharVerified", width: 15 },
      { header: "Suspended", key: "isSuspended", width: 15 },
    ];

    players.forEach((player) => {
      worksheet.addRow({
        ...player,
        club: player.club?.clubName || "No Club",
        dateOfBirth: player.dateOfBirth.toISOString().split("T")[0],
      });
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", "attachment; filename=players.xlsx");

    await workbook.xlsx.write(res);
    res.end();
    return;
  }

  const [players, totalPlayers] = await Promise.all([
    prisma.player.findMany({
      where,
      include: {
        groups: true,
        club: true,
      },
      orderBy,
      skip,
      take,
    }),
    prisma.player.count({ where }),
  ]);

  const totalPages = Math.ceil(totalPlayers / take);

  res.json({
    players,
    page: parseInt(page),
    totalPages,
    totalPlayers,
  });
});

// Export players to Excel with filters
const exportPlayers = asyncHandler(async (req, res) => {
  const {
    search = "",
    clubId,
    isSuspended,
    aadharVerified,
    sortBy = "id",
    sortOrder = "asc",
  } = req.query;

  const where = {};

  // Filter by club based on user role
  if (req.user) {
    if (req.user.role === "clubadmin" && req.user.clubId) {
      where.clubId = req.user.clubId;
    } else if (req.user.role === "CLUB") {
      const clubAdminUser = await prisma.user.findFirst({
        where: {
          email: req.user.email,
          role: "clubadmin",
        },
      });
      if (clubAdminUser && clubAdminUser.clubId) {
        where.clubId = clubAdminUser.clubId;
      }
    }
  }

  if (!isBlankish(clubId)) {
    const parsedClubId = parseInt(String(clubId), 10);
    if (Number.isNaN(parsedClubId)) {
      throw createError(400, "Invalid club ID");
    }
    if (!where.clubId) {
      where.clubId = parsedClubId;
    }
  }

  if (search) {
    where.OR = [
      { firstName: { contains: search } },
      { lastName: { contains: search } },
      { uniqueIdNumber: { contains: search } },
      { aadharNumber: { contains: search } },
    ];
  }

  if (isSuspended !== undefined) {
    where.isSuspended = isSuspended === "true";
  }

  if (aadharVerified !== undefined) {
    where.aadharVerified = aadharVerified === "true";
  }

  const orderBy = { [sortBy]: sortOrder };

  const players = await prisma.player.findMany({
    where,
    include: {
      groups: true,
      club: {
        include: {
          place: {
            include: {
              region: true,
            },
          },
        },
      },
    },
    orderBy,
  });

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Players");

  worksheet.columns = [
    { header: "ID", key: "id", width: 10 },
    { header: "Unique ID", key: "uniqueIdNumber", width: 18 },
    { header: "First Name", key: "firstName", width: 16 },
    { header: "Middle Name", key: "middleName", width: 16 },
    { header: "Last Name", key: "lastName", width: 16 },
    { header: "Mother Name", key: "motherName", width: 18 },
    { header: "Date of Birth", key: "dateOfBirth", width: 14 },
    { header: "Playing Position", key: "position", width: 18 },
    { header: "Mobile", key: "mobile", width: 14 },
    { header: "Aadhaar Number", key: "aadharNumber", width: 18 },
    { header: "Club", key: "club", width: 26 },
    { header: "Region", key: "region", width: 18 },
    { header: "Place", key: "place", width: 18 },
    { header: "Groups", key: "groups", width: 30 },
    { header: "Aadhaar Verified", key: "aadharVerified", width: 16 },
    { header: "Suspended", key: "isSuspended", width: 12 },
  ];

  players.forEach((player) => {
    worksheet.addRow({
      id: player.id,
      uniqueIdNumber: player.uniqueIdNumber,
      firstName: player.firstName,
      middleName: player.middleName || "",
      lastName: player.lastName,
      motherName: player.motherName || "",
      dateOfBirth: player.dateOfBirth ? player.dateOfBirth.toISOString().split("T")[0] : "",
      position: player.position || "",
      mobile: player.mobile,
      aadharNumber: player.aadharNumber,
      club: player.club?.clubName || "No Club",
      region: player.club?.place?.region?.regionName || "",
      place: player.club?.place?.placeName || "",
      groups: Array.isArray(player.groups) ? player.groups.map((g) => g.groupName).join(", ") : "",
      aadharVerified: player.aadharVerified ? "Yes" : "No",
      isSuspended: player.isSuspended ? "Yes" : "No",
    });
  });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="TDKA_Players_Export.xlsx"'
  );

  await workbook.xlsx.write(res);
  res.end();
});

// Get player by ID
const getPlayerById = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.id);
  if (!playerId) throw createError(400, "Invalid player ID");

  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: {
      groups: true,
      club: {
        include: {
          place: {
            include: {
              region: true,
            },
          },
        },
      },
    },
  });

  if (!player) throw createError(404, "Player not found");

  if (req.user) {
    const role = (req.user.role || "").toLowerCase();
    if (role === "clubadmin" && req.user.clubId) {
      if (player.clubId !== req.user.clubId) {
        throw createError(403, "Forbidden");
      }
    }
    if (role === "club" && req.user.clubId) {
      if (player.clubId !== req.user.clubId) {
        throw createError(403, "Forbidden");
      }
    }
  }

  res.json(player);
});

const createPlayer = asyncHandler(async (req, res) => {
  if (hasUploadErrors(req)) {
    return res.status(400).json({ errors: req.uploadErrors });
  }

  const body = req.body || {};
  const groupIds = parseGroupIds(body.groupIds);
  const isAdmin = String(req.user?.role || "").toLowerCase() === "admin";
  const clubIdFromUser = await resolveClubIdFromReqUser(req);

  const clubId = isAdmin
    ? (body.clubId ? parseInt(body.clubId, 10) : null)
    : clubIdFromUser;

  const dateOfBirth = body.dateOfBirth ? new Date(body.dateOfBirth) : null;
  if (!body.firstName || !body.lastName || !dateOfBirth || !body.address || !body.mobile || !body.aadharNumber) {
    throw createError(400, "Missing required fields");
  }

  const mobile = String(body.mobile || "").trim();
  if (!/^\d{10}$/.test(mobile)) {
    throw createError(400, "Invalid mobile number");
  }

  const aadharNumber = String(body.aadharNumber || "").trim();
  if (!/^\d{12}$/.test(aadharNumber)) {
    throw createError(400, "Invalid Aadhaar number");
  }

  const profileImage = getUploadedFilePath(req, "profileImage");
  const aadharImage = getUploadedFilePath(req, "aadharImage");

  try {
    const uniqueIdNumber = await generateUniquePlayerIdNumber();
    const player = await prisma.player.create({
      data: {
        uniqueIdNumber,
        firstName: String(body.firstName).trim(),
        middleName: body.middleName ? String(body.middleName).trim() : null,
        lastName: String(body.lastName).trim(),
        motherName: body.motherName ? String(body.motherName).trim() : null,
        dateOfBirth,
        position: body.position ? String(body.position).trim() : null,
        address: String(body.address).trim(),
        mobile,
        aadharNumber,
        clubId: clubId || null,
        profileImage: profileImage || null,
        aadharImage: aadharImage || null,
        groups: {
          connect: groupIds.map((id) => ({ id })),
        },
      },
      include: {
        groups: true,
        club: true,
      },
    });

    res.status(201).json(player);
  } catch (err) {
    if (req.cleanupUpload) {
      try {
        await req.cleanupUpload(req);
      } catch (_) {
        // ignore
      }
    }
    if (err && err.code === "P2002") {
      return res.status(400).json({ errors: { message: "Duplicate value" } });
    }
    throw err;
  }
});

const updatePlayer = asyncHandler(async (req, res) => {
  if (hasUploadErrors(req)) {
    return res.status(400).json({ errors: req.uploadErrors });
  }

  const playerId = parseInt(req.params.id);
  if (!playerId) throw createError(400, "Invalid player ID");

  const existing = await prisma.player.findUnique({
    where: { id: playerId },
    select: { id: true, clubId: true, profileImage: true, aadharImage: true },
  });
  if (!existing) throw createError(404, "Player not found");

  const role = String(req.user?.role || "").toLowerCase();
  const clubIdFromUser = await resolveClubIdFromReqUser(req);
  const isAdmin = role === "admin";
  if (!isAdmin && clubIdFromUser && existing.clubId && existing.clubId !== clubIdFromUser) {
    throw createError(403, "Forbidden");
  }

  const body = req.body || {};
  const groupIds = parseGroupIds(body.groupIds);
  const profileImage = getUploadedFilePath(req, "profileImage");
  const aadharImage = getUploadedFilePath(req, "aadharImage");

  const clubId = isAdmin
    ? (body.clubId !== undefined && body.clubId !== null && String(body.clubId).trim() !== ""
        ? parseInt(body.clubId, 10)
        : existing.clubId ?? null)
    : clubIdFromUser ?? existing.clubId ?? null;

  const updateData = {
    firstName: body.firstName !== undefined ? String(body.firstName).trim() : undefined,
    middleName: body.middleName !== undefined ? (String(body.middleName).trim() || null) : undefined,
    lastName: body.lastName !== undefined ? String(body.lastName).trim() : undefined,
    motherName: body.motherName !== undefined ? (String(body.motherName).trim() || null) : undefined,
    dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : undefined,
    position: body.position !== undefined ? (String(body.position).trim() || null) : undefined,
    address: body.address !== undefined ? String(body.address).trim() : undefined,
    mobile: body.mobile !== undefined ? String(body.mobile).trim() : undefined,
    aadharNumber: body.aadharNumber ? String(body.aadharNumber).trim() : undefined,
    clubId,
    profileImage: profileImage || undefined,
    aadharImage: aadharImage || undefined,
  };

  if (updateData.mobile !== undefined && !/^\d{10}$/.test(String(updateData.mobile))) {
    throw createError(400, "Invalid mobile number");
  }
  if (updateData.aadharNumber !== undefined && updateData.aadharNumber !== "" && !/^\d{12}$/.test(String(updateData.aadharNumber))) {
    throw createError(400, "Invalid Aadhaar number");
  }

  try {
    const player = await prisma.player.update({
      where: { id: playerId },
      data: {
        ...updateData,
        groups: groupIds.length ? { set: groupIds.map((id) => ({ id })) } : undefined,
      },
      include: {
        groups: true,
        club: true,
      },
    });
    res.json(player);
  } catch (err) {
    if (req.cleanupUpload) {
      try {
        await req.cleanupUpload(req);
      } catch (_) {
        // ignore
      }
    }
    if (err && err.code === "P2002") {
      return res.status(400).json({ errors: { message: "Duplicate value" } });
    }
    throw err;
  }
});

const toggleSuspension = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.id);
  if (!playerId) throw createError(400, "Invalid player ID");

  const isSuspended = !!req.body?.isSuspended;
  const existing = await prisma.player.findUnique({
    where: { id: playerId },
    select: { id: true, clubId: true },
  });
  if (!existing) throw createError(404, "Player not found");

  const role = String(req.user?.role || "").toLowerCase();
  const clubIdFromUser = await resolveClubIdFromReqUser(req);
  if (role !== "admin" && clubIdFromUser && existing.clubId && existing.clubId !== clubIdFromUser) {
    throw createError(403, "Forbidden");
  }

  const player = await prisma.player.update({
    where: { id: playerId },
    data: { isSuspended },
    include: { groups: true, club: true },
  });
  res.json(player);
});

const toggleAadharVerification = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.id);
  if (!playerId) throw createError(400, "Invalid player ID");

  const aadharVerified = !!req.body?.aadharVerified;
  const existing = await prisma.player.findUnique({
    where: { id: playerId },
    select: { id: true, clubId: true },
  });
  if (!existing) throw createError(404, "Player not found");

  const role = String(req.user?.role || "").toLowerCase();
  const clubIdFromUser = await resolveClubIdFromReqUser(req);
  if (role !== "admin" && clubIdFromUser && existing.clubId && existing.clubId !== clubIdFromUser) {
    throw createError(403, "Forbidden");
  }

  const player = await prisma.player.update({
    where: { id: playerId },
    data: { aadharVerified },
    include: { groups: true, club: true },
  });
  res.json(player);
});

const getPlayerClub = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.playerId);
  if (!playerId) throw createError(400, "Invalid player ID");

  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: {
      id: true,
      clubId: true,
      club: {
        include: {
          place: {
            include: {
              region: true,
            },
          },
        },
      },
    },
  });

  if (!player) throw createError(404, "Player not found");

  const role = String(req.user?.role || "").toLowerCase();
  const clubIdFromUser = await resolveClubIdFromReqUser(req);
  if (role !== "admin" && clubIdFromUser && player.clubId && player.clubId !== clubIdFromUser) {
    throw createError(403, "Forbidden");
  }

  res.json({ club: player.club });
});

const getClubPlayers = asyncHandler(async (req, res) => {
  const clubId = parseInt(req.params.clubId);
  if (!clubId) throw createError(400, "Invalid club ID");

  const role = String(req.user?.role || "").toLowerCase();
  const clubIdFromUser = await resolveClubIdFromReqUser(req);
  if (role !== "admin" && clubIdFromUser && clubId !== clubIdFromUser) {
    throw createError(403, "Forbidden");
  }

  const players = await prisma.player.findMany({
    where: { clubId },
    include: { groups: true, club: true },
    orderBy: { firstName: "asc" },
  });

  res.json({ players });
});

const transferPlayer = asyncHandler(async (req, res) => {
  const role = String(req.user?.role || "").toLowerCase();
  if (role !== "admin") throw createError(403, "Forbidden");

  const playerId = parseInt(req.body?.playerId);
  const clubId = req.body?.clubId !== undefined && req.body?.clubId !== null && String(req.body.clubId).trim() !== ""
    ? parseInt(req.body.clubId, 10)
    : null;

  if (!playerId) throw createError(400, "Invalid player ID");
  if (clubId !== null && Number.isNaN(clubId)) throw createError(400, "Invalid club ID");

  const player = await prisma.player.update({
    where: { id: playerId },
    data: { clubId },
    include: { groups: true, club: true },
  });

  res.json(player);
});

const removePlayerFromClub = asyncHandler(async (req, res) => {
  const role = String(req.user?.role || "").toLowerCase();
  if (role !== "admin") throw createError(403, "Forbidden");

  const playerId = parseInt(req.params.playerId);
  if (!playerId) throw createError(400, "Invalid player ID");

  const player = await prisma.player.update({
    where: { id: playerId },
    data: { clubId: null },
    include: { groups: true, club: true },
  });

  res.json(player);
});

const getClubStats = asyncHandler(async (req, res) => {
  const role = String(req.user?.role || "").toLowerCase();
  if (role !== "admin") throw createError(403, "Forbidden");

  const clubs = await prisma.club.findMany({
    select: {
      id: true,
      clubName: true,
      _count: { select: { players: true } },
    },
    orderBy: { clubName: "asc" },
  });

  res.json({ clubs: clubs.map((c) => ({ id: c.id, clubName: c.clubName, playerCount: c._count.players })) });
});

const verifyAadharOCR = asyncHandler(async (req, res) => {
  const aadharNumber = String(req.body?.aadharNumber || "").trim();
  const filePath = getUploadedFilePath(req, "file") || getUploadedFilePath(req, "aadharImage");
  const playerId = req.params?.id ? parseInt(req.params.id, 10) : null;

  if (!/^\d{12}$/.test(aadharNumber)) {
    return res.status(400).json({ errors: { aadharNumber: { type: "validation", message: "Invalid Aadhaar number" } } });
  }

  if (playerId) {
    const player = await prisma.player.findUnique({
      where: { id: playerId },
      select: { id: true, aadharNumber: true, clubId: true },
    });

    if (!player) throw createError(404, "Player not found");

    const role = String(req.user?.role || "").toLowerCase();
    const clubIdFromUser = await resolveClubIdFromReqUser(req);
    if (role !== "admin" && clubIdFromUser && player.clubId && player.clubId !== clubIdFromUser) {
      throw createError(403, "Forbidden");
    }

    const ok = player.aadharNumber === aadharNumber;
    return res.json({
      aadharVerified: ok,
      mismatchReasons: ok ? [] : ["Aadhar number does not match"],
      fileReceived: !!filePath,
    });
  }

  return res.json({
    aadharVerified: false,
    mismatchReasons: ["Aadhar number does not match"],
    fileReceived: !!filePath,
  });
});

const generatePlayerICardPDF = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.id);
  if (!playerId) throw createError(400, "Invalid player ID");

  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: {
      groups: true,
      club: {
        include: {
          place: {
            include: { region: true },
          },
        },
      },
    },
  });
  if (!player) throw createError(404, "Player not found");

  const role = String(req.user?.role || "").toLowerCase();
  const clubIdFromUser = await resolveClubIdFromReqUser(req);
  if (role !== "admin" && clubIdFromUser && player.clubId && player.clubId !== clubIdFromUser) {
    throw createError(403, "Forbidden");
  }

  const doc = new PDFDocument({ size: "A4", margin: 36 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${String(player.uniqueIdNumber || `player_${player.id}`)}_icard.pdf"`
  );

  doc.pipe(res);

  doc.fontSize(18).text("TDKA Player iCard", { align: "center" });
  doc.moveDown(1);

  const fullName = [player.firstName, player.middleName, player.lastName].filter(Boolean).join(" ");
  doc.fontSize(12).text(`Name: ${fullName}`);
  if (player.motherName) doc.text(`Mother Name: ${player.motherName}`);
  doc.text(`Unique ID: ${player.uniqueIdNumber}`);
  doc.text(`Mobile: ${player.mobile}`);
  doc.text(`Aadhaar: ${player.aadharNumber}`);
  doc.text(`DOB: ${player.dateOfBirth.toISOString().split("T")[0]}`);
  if (player.position) doc.text(`Position: ${player.position}`);
  doc.text(`Club: ${player.club?.clubName || "No Club"}`);
  if (player.club?.place?.region?.regionName) doc.text(`Region: ${player.club.place.region.regionName}`);
  if (player.club?.place?.placeName) doc.text(`Place: ${player.club.place.placeName}`);
  doc.text(`Groups: ${(player.groups || []).map((g) => g.groupName).join(", ")}`);

  const imgRel = player.profileImage ? String(player.profileImage).replace(/\\/g, "/") : "";
  if (imgRel) {
    const imgPath = path.isAbsolute(imgRel) ? imgRel : path.join(process.cwd(), imgRel);
    if (fs.existsSync(imgPath)) {
      try {
        doc.image(imgPath, 420, 120, { fit: [140, 140], align: "center", valign: "center" });
      } catch (_) {
        // ignore
      }
    }
  }

  doc.end();
});

module.exports = {
  getPlayers,
  exportPlayers,
  getPlayerById,
  generatePlayerICardPDF,
  createPlayer,
  updatePlayer,
  toggleSuspension,
  toggleAadharVerification,
  getPlayerClub,
  getClubPlayers,
  transferPlayer,
  removePlayerFromClub,
  getClubStats,
  verifyAadharOCR
};