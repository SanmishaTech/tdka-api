const { PrismaClient } = require("@prisma/client");
const asyncHandler = require("express-async-handler");
const createError = require("http-errors");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const prisma = new PrismaClient();

// Get all players with pagination and filtering
const getPlayers = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    search = "",
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
              region: true
            }
          }
        }
      }
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

const generatePlayerICardPDF = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.id);
  if (!playerId) throw createError(400, "Invalid player ID");

  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: {
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
    } else if (role === "club" && req.user.clubId) {
      if (player.clubId !== req.user.clubId) {
        throw createError(403, "Forbidden");
      }
    }
  }

  const fullName = [player.firstName, player.middleName, player.lastName]
    .filter(Boolean)
    .join(" ");
  const dob = player.dateOfBirth ? player.dateOfBirth.toISOString().split("T")[0] : "";
  const clubName = player.club?.clubName || "No Club";
  const regionName = player.club?.place?.region?.regionName || "";

  const safeId = (player.uniqueIdNumber || `player_${player.id}`).replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${safeId}_icard.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`);

  const cardW = 420;
  const cardH = 250;
  const outerPad = 8;
  const headerH = 38;

  const doc = new PDFDocument({ size: [cardW, cardH], margin: 0 });
  doc.pipe(res);

  doc
    .rect(outerPad, outerPad, cardW - outerPad * 2, cardH - outerPad * 2)
    .lineWidth(1.2)
    .stroke("#0f172a");
  doc
    .rect(outerPad, outerPad, cardW - outerPad * 2, headerH)
    .fill("#1e3a8a");
  doc
    .fillColor("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(12)
    .text("TDKA PLAYER ICARD", outerPad + 14, outerPad + 13);

  const resolveImagePath = (p) => {
    if (!p) return null;
    if (/^https?:\/\//i.test(p)) return null;
    if (path.isAbsolute(p)) return fs.existsSync(p) ? p : null;
    const abs = path.resolve(__dirname, "../../", p);
    return fs.existsSync(abs) ? abs : null;
  };

  const resolveTDKALogoPath = () => {
    const candidates = [
      path.resolve(__dirname, "../../..", "frontend", "public", "TDKA logo.png"),
      path.resolve(__dirname, "../../..", "frontend", "dist", "TDKA logo.png"),
      path.resolve(process.cwd(), "frontend", "public", "TDKA logo.png"),
      path.resolve(process.cwd(), "frontend", "dist", "TDKA logo.png"),
      path.resolve(process.cwd(), "TDKA logo.png"),
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

  const leftX = outerPad + 16;
  const contentTop = outerPad + headerH + 18;

  const photoBoxSize = 92;
  const photoX = cardW - outerPad - 16 - photoBoxSize;
  const photoY = contentTop;
  doc.rect(photoX, photoY, photoBoxSize, photoBoxSize).stroke("#94a3b8");

  const imgPath = resolveImagePath(player.profileImage);
  const logoPath = resolveTDKALogoPath();
  const fallbackImagePath = imgPath || logoPath;
  if (fallbackImagePath) {
    try {
      doc.image(fallbackImagePath, photoX + 6, photoY + 6, {
        fit: [photoBoxSize - 12, photoBoxSize - 12],
        align: "center",
        valign: "center",
      });
    } catch (_) {
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#64748b")
        .text("PHOTO ERROR", photoX, photoY + photoBoxSize / 2 - 4, {
          width: photoBoxSize,
          align: "center",
        });
    }
  } else {
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#64748b")
      .text("NO PHOTO", photoX, photoY + photoBoxSize / 2 - 4, {
        width: photoBoxSize,
        align: "center",
      });
  }

  const contentWidth = photoX - leftX - 14;

  doc
    .fillColor("#0f172a")
    .font("Helvetica-Bold")
    .fontSize(16)
    .text(fullName || "-", leftX, contentTop, {
      width: contentWidth,
    });

  const labelColor = "#334155";
  const valueColor = "#0f172a";
  const labelFontSize = 9;
  const valueFontSize = 9;
  const labelW = 56;

  const rowY1 = contentTop + 38;
  doc.font("Helvetica-Bold").fontSize(labelFontSize).fillColor(labelColor).text("DOB:", leftX, rowY1);
  doc.font("Helvetica").fontSize(valueFontSize).fillColor(valueColor).text(dob || "-", leftX + labelW, rowY1, { width: contentWidth - labelW });

  const rowY2 = rowY1 + 18;
  doc.font("Helvetica-Bold").fontSize(labelFontSize).fillColor(labelColor).text("CLUB:", leftX, rowY2);
  doc.font("Helvetica").fontSize(valueFontSize).fillColor(valueColor).text(clubName || "-", leftX + labelW, rowY2, { width: contentWidth - labelW });

  const rowY3 = rowY2 + 18;
  doc.font("Helvetica-Bold").fontSize(labelFontSize).fillColor(labelColor).text("REGION:", leftX, rowY3);
  doc.font("Helvetica").fontSize(valueFontSize).fillColor(valueColor).text(regionName || "-", leftX + labelW, rowY3, { width: contentWidth - labelW });

  doc.end();
});

// Create new player
const createPlayer = asyncHandler(async (req, res) => {
  const {
    firstName,
    middleName,
    lastName,
    motherName,
    dateOfBirth,
    position,
    address,
    mobile,
    aadharNumber,
    clubId,
    groupIds,
  } = req.body;

  const normalizedAadharNumber = String(aadharNumber || "").trim();

  // Determine the clubId to use
  let finalClubId = null;
  
  if (req.user) {
    // If user is a club admin and has a clubId, use it
    if (req.user.role === "clubadmin" && req.user.clubId) {
      finalClubId = req.user.clubId;
    }
    // If user is a club (direct club login), find the associated user's clubId
    else if (req.user.role === "CLUB") {
      // Find the club admin user associated with this club
      const clubAdminUser = await prisma.user.findFirst({
        where: {
          email: req.user.email,
          role: "clubadmin"
        }
      });
      if (clubAdminUser && clubAdminUser.clubId) {
        finalClubId = clubAdminUser.clubId;
      }
    }
    // For other roles (like super admin), use the provided clubId
    else if (clubId) {
      finalClubId = parseInt(clubId);
    }
  } else if (clubId) {
    // Fallback to provided clubId if no user context
    finalClubId = parseInt(clubId);
  }

  // Generate unique ID number based on club
  let uniqueIdNumber;
  
  if (finalClubId) {
    // Get club details to extract the club number from uniqueNumber
    const club = await prisma.club.findUnique({
      where: { id: finalClubId },
      select: { uniqueNumber: true }
    });
    
    if (!club) {
      throw createError(400, "Club not found");
    }
    
    // Extract club number from club's uniqueNumber (e.g., "TDKA/SAD/TDKA01" -> "TDKA01")
    const clubNumberMatch = club.uniqueNumber.match(/(TDKA\d+)$/);
    const clubNumber = clubNumberMatch ? clubNumberMatch[1] : "TDKA00";
    
    // Determine next sequence using the highest existing uniqueIdNumber for this club prefix
    const prefix = `TDKA/${clubNumber}/`;
    const lastPlayer = await prisma.player.findFirst({
      where: { uniqueIdNumber: { startsWith: prefix } },
      orderBy: { uniqueIdNumber: 'desc' },
      select: { uniqueIdNumber: true }
    });
    const lastSeq = lastPlayer ? parseInt((lastPlayer.uniqueIdNumber.split('/').pop() || '0'), 10) : 0;
    const playerSequence = String(lastSeq + 1).padStart(10, "0");
    uniqueIdNumber = `${prefix}${playerSequence}`;
  } else {
    // Fallback for players without clubs
    const prefix = `TDKA/TDKA00/`;
    const lastPlayer = await prisma.player.findFirst({
      where: { uniqueIdNumber: { startsWith: prefix } },
      orderBy: { uniqueIdNumber: 'desc' },
      select: { uniqueIdNumber: true }
    });
    const lastSeq = lastPlayer ? parseInt((lastPlayer.uniqueIdNumber.split('/').pop() || '0'), 10) : 0;
    const playerSequence = String(lastSeq + 1).padStart(10, "0");
    uniqueIdNumber = `${prefix}${playerSequence}`;
  }

  const playerData = {
    uniqueIdNumber,
    firstName,
    middleName,
    lastName,
    motherName,
    dateOfBirth: new Date(dateOfBirth),
    position,
    address,
    mobile,
    aadharNumber: normalizedAadharNumber,
    clubId: finalClubId,
  };

  if (req.files?.profileImage) {
    playerData.profileImage = req.files.profileImage[0].path;
  }
  if (req.files?.aadharImage) {
    playerData.aadharImage = req.files.aadharImage[0].path;
  }

  try {
    const player = await prisma.player.create({
      data: {
        ...playerData,
        groups: groupIds
          ? {
              connect: (() => {
                try {
                  const parsedGroupIds = Array.isArray(groupIds) ? groupIds : JSON.parse(groupIds);
                  return parsedGroupIds.map((id) => ({ id: parseInt(id) }));
                } catch (error) {
                  console.error('Error parsing groupIds:', error);
                  throw createError(400, 'Invalid groupIds format');
                }
              })(),
            }
          : undefined,
      },
      include: {
        groups: true,
        club: true,
      },
    });

    res.status(201).json(player);
  } catch (error) {
    if (error.code === 'P2002') {
      const target = error.meta?.target;
      const fields = Array.isArray(target) ? target : (typeof target === 'string' ? [target] : []);
      let message = 'A player with this information already exists.';
      
      if (fields.includes('aadharNumber')) {
        const role = (req.user?.role || "").toLowerCase();
        if ((role === "clubadmin" || role === "club") && finalClubId) {
          const existingPlayer = await prisma.player.findUnique({
            where: { aadharNumber: normalizedAadharNumber },
            include: {
              groups: true,
              club: true,
            },
          });

          if (existingPlayer?.isSuspended) {
            const updatedPlayer = await prisma.player.update({
              where: { id: existingPlayer.id },
              data: {
                clubId: finalClubId,
                isSuspended: false,
                profileImage: req.files?.profileImage ? req.files.profileImage[0].path : undefined,
                aadharImage: req.files?.aadharImage ? req.files.aadharImage[0].path : undefined,
                groups: groupIds
                  ? {
                      set: (() => {
                        try {
                          const parsedGroupIds = Array.isArray(groupIds) ? groupIds : JSON.parse(groupIds);
                          return parsedGroupIds.map((id) => ({ id: parseInt(id) }));
                        } catch (err) {
                          console.error('Error parsing groupIds:', err);
                          throw createError(400, 'Invalid groupIds format');
                        }
                      })(),
                    }
                  : undefined,
              },
              include: {
                groups: true,
                club: true,
              },
            });

            res.status(200).json(updatedPlayer);
            return;
          }

          if (existingPlayer && existingPlayer.clubId && existingPlayer.clubId !== finalClubId) {
            throw createError(409, "Player is currently active with another club. Ask the current club to suspend the player before adding here.");
          }

          if (existingPlayer && existingPlayer.clubId === finalClubId) {
            throw createError(409, "Player already exists in your club.");
          }
        }

        message = 'A player with this Aadhar number already exists. Please check the Aadhar number and try again.';
      } else if (fields.includes('mobile')) {
        message = 'A player with this mobile number already exists. Please check the mobile number and try again.';
      } else if (fields.includes('uniqueIdNumber')) {
        message = 'A player with this unique ID already exists. Please try again.';
      }
      
      throw createError(409, message);
    }
    
    throw error;
  }
});

// Toggle suspension status
const toggleSuspension = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.id);
  if (!playerId) throw createError(400, "Invalid player ID");

  const { isSuspended } = req.body;

  if (typeof isSuspended !== "boolean") {
    throw createError(400, "isSuspended must be a boolean");
  }

  const existing = await prisma.player.findUnique({
    where: { id: playerId },
    select: { clubId: true },
  });

  if (!existing) throw createError(404, "Player not found");

  if (req.user) {
    const role = (req.user.role || "").toLowerCase();
    if (role === "clubadmin" && req.user.clubId) {
      if (existing.clubId !== req.user.clubId) {
        throw createError(403, "Forbidden");
      }
    }
    if (role === "club" && req.user.clubId) {
      if (existing.clubId !== req.user.clubId) {
        throw createError(403, "Forbidden");
      }
    }
  }

  const player = await prisma.player.update({
    where: { id: playerId },
    data: { isSuspended },
    include: {
      groups: true,
      club: true,
    },
  });

  res.json(player);
});

const toggleAadharVerification = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.id);
  if (!playerId) throw createError(400, "Invalid player ID");

  const { aadharVerified } = req.body;

  if (typeof aadharVerified !== "boolean") {
    throw createError(400, "aadharVerified must be a boolean");
  }

  const existing = await prisma.player.findUnique({
    where: { id: playerId },
    select: { clubId: true },
  });

  if (!existing) throw createError(404, "Player not found");

  if (req.user) {
    const role = (req.user.role || "").toLowerCase();
    if (role === "clubadmin" && req.user.clubId) {
      if (existing.clubId !== req.user.clubId) {
        throw createError(403, "Forbidden");
      }
    }
    if (role === "club" && req.user.clubId) {
      if (existing.clubId !== req.user.clubId) {
        throw createError(403, "Forbidden");
      }
    }
  }

  const player = await prisma.player.update({
    where: { id: playerId },
    data: { aadharVerified },
    include: {
      groups: true,
      club: true,
    },
  });

  res.json(player);
});

const getPlayerClub = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.playerId);
  if (!playerId) throw createError(400, "Invalid player ID");

  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: {
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

  res.json({
    player: {
      id: player.id,
      name: `${player.firstName} ${player.lastName}`,
      club: player.club,
    }
  });
});

const getClubPlayers = asyncHandler(async (req, res) => {
  const clubId = parseInt(req.params.clubId);
  if (!clubId) throw createError(400, "Invalid club ID");

  if (req.user) {
    const role = (req.user.role || "").toLowerCase();
    if ((role === "clubadmin" || role === "club") && req.user.clubId) {
      if (clubId !== req.user.clubId) {
        throw createError(403, "Forbidden");
      }
    }
  }

  const players = await prisma.player.findMany({
    where: { clubId },
    include: {
      groups: true,
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }]
  });

  res.json(players);
});

const updatePlayer = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.id);
  if (!playerId) throw createError(400, "Invalid player ID");

  const existing = await prisma.player.findUnique({
    where: { id: playerId },
    select: { clubId: true },
  });

  if (!existing) throw createError(404, "Player not found");

  const role = (req.user?.role || "").toLowerCase();
  if ((role === "clubadmin" || role === "club") && req.user?.clubId) {
    if (existing.clubId !== req.user.clubId) {
      throw createError(403, "Forbidden");
    }
  }

  const {
    firstName,
    middleName,
    lastName,
    motherName,
    dateOfBirth,
    position,
    address,
    mobile,
    aadharNumber,
    clubId,
    groupIds,
  } = req.body;

  const data = {
    firstName,
    middleName,
    lastName,
    motherName,
    position,
    address,
    mobile,
    aadharNumber: aadharNumber !== undefined ? String(aadharNumber || "").trim() : undefined,
    dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
  };

  if (role !== "clubadmin" && role !== "club") {
    if (clubId !== undefined && clubId !== null && clubId !== "") {
      data.clubId = parseInt(clubId);
    }
  }

  if (req.files?.profileImage) {
    data.profileImage = req.files.profileImage[0].path;
  }
  if (req.files?.aadharImage) {
    data.aadharImage = req.files.aadharImage[0].path;
  }

  if (groupIds) {
    data.groups = {
      set: (() => {
        try {
          const parsedGroupIds = Array.isArray(groupIds) ? groupIds : JSON.parse(groupIds);
          return parsedGroupIds.map((id) => ({ id: parseInt(id) }));
        } catch (err) {
          console.error('Error parsing groupIds:', err);
          throw createError(400, 'Invalid groupIds format');
        }
      })(),
    };
  }

  try {
    const updatedPlayer = await prisma.player.update({
      where: { id: playerId },
      data,
      include: {
        groups: true,
        club: true,
      },
    });

    res.status(200).json(updatedPlayer);
  } catch (error) {
    if (error.code === 'P2002') {
      const target = error.meta?.target;
      const fields = Array.isArray(target) ? target : (typeof target === 'string' ? [target] : []);
      let message = 'A player with this information already exists.';

      if (fields.includes('aadharNumber')) {
        message = 'A player with this Aadhar number already exists. Please check the Aadhar number and try again.';
      } else if (fields.includes('mobile')) {
        message = 'A player with this mobile number already exists. Please check the mobile number and try again.';
      } else if (fields.includes('uniqueIdNumber')) {
        message = 'A player with this unique ID already exists. Please try again.';
      }

      throw createError(409, message);
    }

    throw error;
  }
});

const verifyAadharOCR = asyncHandler(async (req, res) => {
  const playerId = req.params.id ? parseInt(req.params.id) : undefined;
  const { aadharNumber } = req.body;

  if (!aadharNumber || String(aadharNumber).trim().length !== 12) {
    throw createError(400, "Invalid or missing Aadhar number");
  }

  let filePathToUse;

  if (req.files?.aadharImage && req.files.aadharImage[0]) {
    filePathToUse = req.files.aadharImage[0].path;
  } else if (req.files?.file && req.files.file[0]) {
    filePathToUse = req.files.file[0].path;
  }

  if (!filePathToUse && playerId) {
    const player = await prisma.player.findUnique({
      where: { id: playerId },
      select: { aadharImage: true },
    });
    if (!player) throw createError(404, "Player not found");
    if (!player.aadharImage) {
      throw createError(400, "Player does not have an Aadhaar image on record. Upload an image to verify.");
    }
    filePathToUse = player.aadharImage;
  }

  if (!filePathToUse) {
    throw createError(400, "Aadhaar image file is required for verification");
  }

  const CASHFREE_BASE_URL = process.env.CASHFREE_BASE_URL || "https://api.cashfree.com";
  const CASHFREE_CLIENT_ID = process.env.CASHFREE_CLIENT_ID;
  const CASHFREE_CLIENT_SECRET = process.env.CASHFREE_CLIENT_SECRET;
  const CASHFREE_API_VERSION = process.env.CASHFREE_API_VERSION || "2024-12-01";

  if (!CASHFREE_CLIENT_ID || !CASHFREE_CLIENT_SECRET) {
    throw createError(500, "Cashfree credentials not configured");
  }

  const absPath = path.isAbsolute(filePathToUse) ? filePathToUse : path.resolve(filePathToUse);
  const fileBuffer = fs.readFileSync(absPath);
  const origExt = path.extname(absPath) || ".jpg";
  const safeFilename = `aadhaar${origExt}`;
  const mimeType = origExt.toLowerCase() === ".png" ? "image/png" : "image/jpeg";

  const formData = new FormData();
  const verificationId = playerId ? `player_${playerId}_${Date.now()}` : crypto.randomUUID();
  formData.append("verification_id", verificationId);
  formData.append("document_type", "AADHAAR");
  formData.append("file", new File([fileBuffer], safeFilename, { type: mimeType }));

  let result;
  try {
    const resp = await fetch(`${CASHFREE_BASE_URL}/verification/bharat-ocr`, {
      method: "POST",
      headers: {
        "x-api-version": CASHFREE_API_VERSION,
        "x-client-id": CASHFREE_CLIENT_ID,
        "x-client-secret": CASHFREE_CLIENT_SECRET,
      },
      body: formData,
    });

    result = await resp.json().catch(() => null);
    if (!resp.ok) {
      throw createError(resp.status || 500, result?.message || "Failed to verify Aadhaar via Cashfree");
    }
  } catch (err) {
    if (err?.status && err?.message) {
      throw err;
    }
    throw createError(500, err?.message || "Failed to verify Aadhaar via Cashfree");
  }

  const normalizeDigits = (val) => (val ?? "").toString().replace(/\D/g, "");
  const inputAadharDigits = normalizeDigits(aadharNumber);

  let nameMatch = true;
  let dobMatch = true;
  let aadharNumberMatch = true;
  const mismatchReasons = [];

  const docAadharRaw =
    result?.document_fields?.aadhaar_number ??
    result?.document_fields?.aadhar_number ??
    result?.document_fields?.aadhaar ??
    result?.document_fields?.document_number ??
    result?.document_fields?.id_number ??
    result?.document_fields?.uid ??
    result?.document_fields?.uid_number;
  const docAadharDigits = normalizeDigits(docAadharRaw);

  if (result?.document_fields) {
    if (docAadharDigits.length === 12) {
      aadharNumberMatch = docAadharDigits === inputAadharDigits;
    } else if (docAadharDigits.length >= 4) {
      aadharNumberMatch = inputAadharDigits.endsWith(docAadharDigits);
    } else {
      aadharNumberMatch = false;
    }

    if (!aadharNumberMatch) mismatchReasons.push("Aadhar number does not match");
  } else {
    aadharNumberMatch = false;
    mismatchReasons.push("Aadhar number does not match");
  }

  if (playerId && result?.document_fields) {
    const docName = (result.document_fields.name || "").trim().toLowerCase().replace(/\s+/g, " ");
    const docDob = result.document_fields.dob;

    const player = await prisma.player.findUnique({
      where: { id: playerId },
      select: { firstName: true, lastName: true, dateOfBirth: true, aadharNumber: true }
    });

    if (player) {
      const playerAadharDigits = normalizeDigits(player.aadharNumber);
      if (playerAadharDigits && inputAadharDigits && playerAadharDigits !== inputAadharDigits) {
        aadharNumberMatch = false;
        if (!mismatchReasons.includes("Aadhar number does not match")) {
          mismatchReasons.push("Aadhar number does not match");
        }
      }

      const docTokens = docName.split(" ");
      const firstMatch = docTokens.includes(player.firstName.toLowerCase());
      const lastMatch = docTokens.includes(player.lastName.toLowerCase());
      nameMatch = firstMatch && lastMatch;
      if (!nameMatch) mismatchReasons.push("Name does not match");

      if (docDob) {
        const playerDobStr = player.dateOfBirth.toISOString().split("T")[0];
        dobMatch = playerDobStr === docDob;
        if (!dobMatch) mismatchReasons.push("Date of birth does not match");
      }
    }
  }

  const allMatch = nameMatch && dobMatch && aadharNumberMatch;

  if (playerId && result?.status === "VALID" && allMatch) {
    await prisma.player.update({
      where: { id: playerId },
      data: { aadharVerified: true },
    });
  }

  res.status(200).json({
    success: true,
    cashfreeResponse: result,
    aadharVerified: result?.status === "VALID" && allMatch,
    aadharNumberMatch,
    allMatch,
    mismatchReasons,
  });
});

// Transfer player to a new club
const transferPlayer = asyncHandler(async (req, res) => {
  const { playerId, newClubId, transferReason, uniqueIdNumber, aadharNumber } = req.body;

  const role = (req.user?.role || "").toLowerCase();

  let targetClubId;
  if (role === "clubadmin" && req.user?.clubId) {
    targetClubId = req.user.clubId;
  } else if (role === "admin") {
    if (!newClubId) {
      throw createError(400, "New club ID is required");
    }
    targetClubId = parseInt(newClubId);
  } else {
    throw createError(403, "Forbidden");
  }

  let player;
  if (playerId) {
    player = await prisma.player.findUnique({
      where: { id: parseInt(playerId) },
      include: { club: true },
    });
  } else if (uniqueIdNumber) {
    player = await prisma.player.findUnique({
      where: { uniqueIdNumber: String(uniqueIdNumber).trim() },
      include: { club: true },
    });
  } else if (aadharNumber) {
    player = await prisma.player.findUnique({
      where: { aadharNumber: String(aadharNumber).trim() },
      include: { club: true },
    });
  } else {
    throw createError(400, "Player ID, Unique ID, or Aadhaar number is required");
  }

  if (!player) throw createError(404, "Player not found");

  if (role === "clubadmin") {
    if (!player.isSuspended) {
      throw createError(403, "Player must be suspended before transferring");
    }
  }

  // Check if new club exists
  const newClub = await prisma.club.findUnique({
    where: { id: targetClubId },
  });

  if (!newClub) throw createError(404, "New club not found");

  // Update player's club
  const updatedPlayer = await prisma.player.update({
    where: { id: player.id },
    data: { clubId: targetClubId, isSuspended: false },
    include: {
      club: true,
    },
  });

  res.status(200).json({
    message: "Player transfer completed successfully",
    player: updatedPlayer,
    previousClub: player.club,
    newClub: newClub,
  });
});

// Remove player from club
const removePlayerFromClub = asyncHandler(async (req, res) => {
  const playerId = parseInt(req.params.playerId);
  if (!playerId) throw createError(400, "Invalid player ID");

  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: { club: true }
  });

  if (!player) throw createError(404, "Player not found");
  if (!player.clubId) throw createError(400, "Player is not associated with any club");

  const updatedPlayer = await prisma.player.update({
    where: { id: playerId },
    data: { clubId: null }
  });

  res.json({
    message: "Player removed from club successfully",
    player: updatedPlayer,
    previousClub: player.club
  });
});

// Get club statistics
const getClubStats = asyncHandler(async (req, res) => {
  const stats = await prisma.$transaction(async (tx) => {
    const totalPlayers = await tx.player.count();
    const playersWithClubs = await tx.player.count({
      where: { clubId: { not: null } }
    });
    const playersWithoutClubs = totalPlayers - playersWithClubs;

    const clubsWithPlayers = await tx.club.findMany({
      include: {
        _count: {
          select: { players: true }
        }
      },
      orderBy: {
        players: {
          _count: 'desc'
        }
      }
    });

    return {
      totalPlayers,
      playersWithClubs,
      playersWithoutClubs,
      totalClubs: clubsWithPlayers.length,
      clubsWithPlayers: clubsWithPlayers.filter(club => club._count.players > 0).length,
      topClubsByPlayerCount: clubsWithPlayers.slice(0, 5).map(club => ({
        clubName: club.clubName,
        playerCount: club._count.players
      }))
    };
  });

  res.json(stats);
});

module.exports = {
  getPlayers,
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