const { PrismaClient } = require("@prisma/client");
const asyncHandler = require("express-async-handler");
const createError = require("http-errors");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let sharp = null;
try {
  sharp = require("sharp");
} catch (_) {
  sharp = null;
}

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

const getThumbPath = (absPath, size, quality) => {
  if (!absPath) return null;
  const dir = path.dirname(absPath);
  return path.join(dir, `__thumb_${size}_q${quality}.jpg`);
};

const ensureThumbnail = async (absPath, size, quality) => {
  if (!absPath) return null;
  if (!sharp) return absPath;

  const thumbPath = getThumbPath(absPath, size, quality);
  if (!thumbPath) return absPath;

  try {
    const [srcStat, thumbStat] = await Promise.all([
      fs.promises.stat(absPath),
      fs.promises.stat(thumbPath).catch(() => null),
    ]);

    if (thumbStat && thumbStat.mtimeMs >= srcStat.mtimeMs) {
      return thumbPath;
    }

    await sharp(absPath)
      .rotate()
      .resize(size, size, { fit: "cover" })
      .jpeg({ quality, mozjpeg: true })
      .toFile(thumbPath);

    return thumbPath;
  } catch (_) {
    return absPath;
  }
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

const resolveLocalImagePath = (p) => {
  if (!p) return null;
  const raw = String(p).trim();
  const uploadsRoot = path.resolve(__dirname, "..", "..", "uploads");

  const mapUploadsPath = (maybePath) => {
    if (!maybePath) return null;
    const s = String(maybePath).trim();
    const normalized = s.replace(/\\/g, "/");
    const idx = normalized.toLowerCase().indexOf("/uploads/");
    if (idx >= 0) {
      const rel = normalized.slice(idx + "/uploads/".length);
      const abs = path.resolve(uploadsRoot, rel);
      try {
        return fs.existsSync(abs) ? abs : null;
      } catch (_) {
        return null;
      }
    }

    if (/^uploads\//i.test(normalized)) {
      const rel = normalized.replace(/^uploads\//i, "");
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
      return null;
    }
    return null;
  }

  const mapped = mapUploadsPath(raw);
  if (mapped) return mapped;

  try {
    if (path.isAbsolute(raw)) return fs.existsSync(raw) ? raw : null;
  } catch (_) {
    return null;
  }

  const candidates = [
    path.resolve(process.cwd(), raw),
    path.resolve(process.cwd(), "backend", raw),
    path.resolve(__dirname, "../../..", raw),
    path.resolve(__dirname, "../../..", "backend", raw),
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
          role: "clubadmin",
        },
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

const exportPlayersPDF = asyncHandler(async (req, res) => {
  const {
    search = "",
    clubId,
    isSuspended,
    aadharVerified,
    sortBy = "id",
    sortOrder = "asc",
  } = req.query;

  const where = {};

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

  const isCompressedExport = players.length > 1000;
  const thumbSize = isCompressedExport ? 64 : 96;
  const thumbQuality = isCompressedExport ? 45 : 60;

  const doc = new PDFDocument({ size: "A4", margin: 36 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${isCompressedExport ? "TDKA_Players_Export_Compressed" : "TDKA_Players_Export"}.pdf"`
  );
  doc.pipe(res);

  const resolveTDKALogoPath = () => {
    const candidates = [
      path.resolve(__dirname, "../../..", "frontend", "public", "TDKA logo.png"),
      path.resolve(__dirname, "../../..", "frontend", "dist", "TDKA logo.png"),
      path.resolve(process.cwd(), "frontend", "public", "TDKA logo.png"),
      path.resolve(process.cwd(), "frontend", "dist", "TDKA logo.png"),
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

  const logoPath = resolveTDKALogoPath();
  const primaryRed = "#dc2626";
  const headerLineColor = "#000000";
  const assocName = "THANE JILHA KABADDI ASSOCIATION";

  let clubNameForHeader = null;
  if (where.clubId) {
    try {
      const club = await prisma.club.findUnique({
        where: { id: where.clubId },
        select: { clubName: true },
      });
      clubNameForHeader = club?.clubName || null;
    } catch (_) {
      clubNameForHeader = null;
    }
  }

  const filters = [];
  if (String(search || "").trim()) {
    filters.push(`Search: ${String(search).trim()}`);
  }
  if (where.clubId) {
    filters.push(`Club: ${clubNameForHeader || String(where.clubId)}`);
  }
  if (isSuspended !== undefined) {
    filters.push(`Suspended: ${isSuspended === "true" ? "Yes" : "No"}`);
  }
  if (aadharVerified !== undefined) {
    filters.push(`Aadhaar Verified: ${aadharVerified === "true" ? "Yes" : "No"}`);
  }
  const filtersLine = filters.length ? `Filters: ${filters.join(" | ")}` : "All Players";

  const drawLetterhead = () => {
    const pageLeft = doc.page.margins.left;
    const pageRight = doc.page.width - doc.page.margins.right;
    const contentW = pageRight - pageLeft;
    const topY = doc.page.margins.top;
    const logoSize = 56;

    if (logoPath) {
      try {
        doc.image(logoPath, pageLeft, topY, { fit: [logoSize, logoSize] });
      } catch (_) {
        // ignore
      }
    }

    doc
      .font("Helvetica-Bold")
      .fontSize(18)
      .fillColor(primaryRed)
      .text(assocName, pageLeft, topY + 2, { width: contentW, align: "center" });

    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("black")
      .text(filtersLine, pageLeft, topY + 30, { width: contentW, align: "center" });

    doc
      .moveTo(pageLeft, topY + 56)
      .lineTo(pageRight, topY + 56)
      .lineWidth(1)
      .stroke(headerLineColor);

    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor("black")
      .text("Players Export", pageLeft, topY + 64, { width: contentW, align: "center" });

    doc.y = topY + 86;
  };

  drawLetterhead();

  const pageLeft = doc.page.margins.left;
  const pageRight = doc.page.width - doc.page.margins.right;
  const pageBottom = doc.page.height - doc.page.margins.bottom;

  const contentW = pageRight - pageLeft;
  const gridGapX = 16;
  const rowGapY = 14;
  const cardW = (contentW - gridGapX) / 2;
  const cardPad = 10;
  const photoBox = 56;
  const photoInset = 4;
  const innerGapX = 10;
  const borderColor = "#9ca3af";

  const newPage = () => {
    doc.addPage();
    drawLetterhead();
  };

  const ensureSpace = (h, currentClubName) => {
    if (doc.y + h > pageBottom) {
      newPage();
      if (currentClubName) {
        doc.font("Helvetica-Bold").fontSize(12).fillColor("#111827");
        doc.text(String(currentClubName), pageLeft, doc.y, { width: contentW });
        doc.moveDown(0.4);
      }
    }
  };

  const drawPlayerCard = async (p, x0, y0, w, h) => {
    const fullName = [p.firstName, p.middleName, p.lastName].filter(Boolean).join(" ").trim() || "-";
    const clubName = p.club?.clubName || "-";
    const regionName = p.club?.place?.region?.regionName || "-";
    const placeName = p.club?.place?.placeName || "-";
    const mobile = p.mobile || "-";
    const uniqueIdNumber = p.uniqueIdNumber || "-";
    const aadharVerifiedText = p.aadharVerified ? "Yes" : "No";

    const locParts = [regionName, placeName].filter((v) => v && v !== "-");
    const locLine = locParts.length ? locParts.join(" • ") : "-";

    const detailsLines = [
      `Unique ID: ${uniqueIdNumber}`,
      `Mobile: ${mobile}`,
      `Club: ${clubName}`,
      locLine !== "-" ? locLine : `${regionName} • ${placeName}`,
      `Aadhaar Verified: ${aadharVerifiedText}`,
    ];

    doc.rect(x0, y0, w, h).lineWidth(1).stroke(borderColor);

    const photoX = x0 + cardPad;
    const photoY = y0 + cardPad;
    doc.rect(photoX, photoY, photoBox, photoBox).lineWidth(1).stroke(borderColor);

    const originalPath = resolveLocalImagePath(p.profileImage);
    const imgPath = await ensureThumbnail(originalPath, thumbSize, thumbQuality);
    if (imgPath) {
      try {
        doc.save();
        doc
          .rect(photoX + photoInset, photoY + photoInset, photoBox - photoInset * 2, photoBox - photoInset * 2)
          .clip();
        doc.image(imgPath, photoX + photoInset, photoY + photoInset, {
          fit: [photoBox - photoInset * 2, photoBox - photoInset * 2],
          align: "center",
          valign: "center",
        });
        doc.restore();
      } catch (_) {
        doc.font("Helvetica").fontSize(7).fillColor("#6b7280").text("PHOTO", photoX, photoY + photoBox / 2 - 4, {
          width: photoBox,
          align: "center",
        });
      }
    } else {
      doc.font("Helvetica").fontSize(7).fillColor("#6b7280").text("NO PHOTO", photoX, photoY + photoBox / 2 - 4, {
        width: photoBox,
        align: "center",
      });
    }

    const textX = photoX + photoBox + innerGapX;
    const textW = Math.max(10, x0 + w - cardPad - textX);

    doc.font("Helvetica-Bold").fontSize(11).fillColor("#111827");
    const nameH = doc.heightOfString(fullName, { width: textW });
    doc.text(fullName, textX, photoY, { width: textW });

    doc.font("Helvetica").fontSize(8).fillColor("#111827");
    const detailsText = detailsLines.filter(Boolean).join("\n");
    doc.text(detailsText, textX, photoY + nameH + 3, { width: textW, lineGap: 1 });
  };

  const clubGroups = new Map();
  for (const p of players) {
    const key = (p.club?.clubName || "No Club").toString();
    const arr = clubGroups.get(key) || [];
    arr.push(p);
    clubGroups.set(key, arr);
  }

  const clubNames = Array.from(clubGroups.keys()).sort((a, b) => String(a).localeCompare(String(b)));

  for (const clubName of clubNames) {
    const clubPlayers = clubGroups.get(clubName) || [];

    doc.font("Helvetica-Bold").fontSize(12);
    const clubTitleH = doc.heightOfString(String(clubName), { width: contentW });
    ensureSpace(clubTitleH + 10, null);
    doc.fillColor("#111827").text(String(clubName), pageLeft, doc.y, { width: contentW });
    doc.moveDown(0.4);

    for (let i = 0; i < clubPlayers.length; i += 2) {
      const leftP = clubPlayers[i];
      const rightP = i + 1 < clubPlayers.length ? clubPlayers[i + 1] : null;

      const measureCardH = (p) => {
        if (!p) return 0;
        const fullName = [p.firstName, p.middleName, p.lastName].filter(Boolean).join(" ").trim() || "-";
        const regionName = p.club?.place?.region?.regionName || "-";
        const placeName = p.club?.place?.placeName || "-";
        const locParts = [regionName, placeName].filter((v) => v && v !== "-");
        const locLine = locParts.length ? locParts.join(" • ") : "-";
        const detailLines = [
          `Unique ID: ${p.uniqueIdNumber || "-"}`,
          `Mobile: ${p.mobile || "-"}`,
          `Club: ${p.club?.clubName || "-"}`,
          locLine !== "-" ? locLine : `${regionName} • ${placeName}`,
          `Aadhaar Verified: ${p.aadharVerified ? "Yes" : "No"}`,
        ];

        const textW = Math.max(10, cardW - cardPad * 2 - photoBox - innerGapX);
        doc.font("Helvetica-Bold").fontSize(11);
        const nameH = doc.heightOfString(fullName, { width: textW });
        doc.font("Helvetica").fontSize(8);
        const detailsH = doc.heightOfString(detailLines.join("\n"), { width: textW, lineGap: 1 });
        return Math.max(photoBox, nameH + 3 + detailsH) + cardPad * 2;
      };

      const rowH = Math.max(measureCardH(leftP), measureCardH(rightP));
      ensureSpace(rowH + rowGapY, clubName);

      const y0 = doc.y;
      await drawPlayerCard(leftP, pageLeft, y0, cardW, rowH);
      if (rightP) {
        await drawPlayerCard(rightP, pageLeft + cardW + gridGapX, y0, cardW, rowH);
      }

      doc.y = y0 + rowH + rowGapY;
    }

    doc.moveDown(0.2);
  }

  doc.end();
});

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
  if (hasUploadErrors(req)) {
    return res.status(400).json({ errors: req.uploadErrors });
  }

  const playerId = req.params?.id ? parseInt(req.params.id, 10) : null;
  const inputAadharNumber = String(req.body?.aadharNumber || "").trim();

  if (!/^\d{12}$/.test(inputAadharNumber)) {
    return res
      .status(400)
      .json({ errors: { aadharNumber: { type: "validation", message: "Invalid Aadhaar number" } } });
  }

  const resolveAbsPath = (p) => {
    if (!p) return null;
    const normalized = String(p).replace(/\\/g, "/");
    if (path.isAbsolute(normalized)) return normalized;
    return path.join(process.cwd(), normalized);
  };

  let filePathToUse = getUploadedFilePath(req, "file") || getUploadedFilePath(req, "aadharImage");
  let fileReceived = !!filePathToUse;

  if (!filePathToUse && playerId) {
    const player = await prisma.player.findUnique({
      where: { id: playerId },
      select: { id: true, aadharImage: true, clubId: true },
    });
    if (!player) throw createError(404, "Player not found");

    const role = String(req.user?.role || "").toLowerCase();
    const clubIdFromUser = await resolveClubIdFromReqUser(req);
    if (role !== "admin" && clubIdFromUser && player.clubId && player.clubId !== clubIdFromUser) {
      throw createError(403, "Forbidden");
    }

    if (!player.aadharImage) {
      throw createError(400, "Player does not have an Aadhaar image on record. Upload an image to verify.");
    }
    filePathToUse = player.aadharImage;
    fileReceived = false;
  }

  if (!filePathToUse) {
    throw createError(400, "Aadhaar image file is required for verification");
  }

  const CASHFREE_CLIENT_ID = process.env.CASHFREE_CLIENT_ID;
  const CASHFREE_CLIENT_SECRET = process.env.CASHFREE_CLIENT_SECRET;
  const CASHFREE_API_VERSION = process.env.CASHFREE_API_VERSION || "2024-12-01";
  const CASHFREE_BASE_URL_RAW =
    process.env.CASHFREE_VERIFICATION_BASE_URL ||
    process.env.CASHFREE_VRS_BASE_URL ||
    process.env.CASHFREE_BASE_URL ||
    (process.env.NODE_ENV === "production"
      ? "https://api.cashfree.com"
      : "https://sandbox.cashfree.com");

  const CASHFREE_VERIFICATION_BASE_URL = (() => {
    const raw = String(CASHFREE_BASE_URL_RAW || "").trim().replace(/\/+$/g, "");
    if (!raw) return raw;
    return raw.endsWith("/verification") ? raw : `${raw}/verification`;
  })();

  if (!CASHFREE_CLIENT_ID || !CASHFREE_CLIENT_SECRET) {
    throw createError(500, "Cashfree credentials not configured");
  }
  if (!CASHFREE_VERIFICATION_BASE_URL) {
    throw createError(500, "Cashfree base URL not configured");
  }
  if (typeof fetch === "undefined" || typeof FormData === "undefined" || typeof Blob === "undefined") {
    throw createError(500, "Server runtime does not support required multipart upload primitives");
  }

  const absPath = resolveAbsPath(filePathToUse);
  if (!absPath || !fs.existsSync(absPath)) {
    throw createError(400, "Aadhaar image file not found on server");
  }

  const fileBuffer = fs.readFileSync(absPath);
  const origExt = path.extname(absPath) || ".jpg";
  const safeFilename = `aadhaar${origExt}`;
  const mimeType = origExt.toLowerCase() === ".png" ? "image/png" : "image/jpeg";

  const verificationId = playerId ? `player_${playerId}_${Date.now()}` : crypto.randomUUID();
  const requestedDocumentTypeRaw = String(process.env.CASHFREE_BHARAT_OCR_DOCUMENT_TYPE || "AADHAAR_FRONT")
    .trim()
    .toUpperCase();

  const documentTypeCandidates = (() => {
    const base = requestedDocumentTypeRaw || "AADHAAR_FRONT";
    if (base === "AADHAAR") return ["AADHAAR", "AADHAAR_FRONT", "AADHAAR_BACK"];
    if (base === "AADHAAR_FRONT") return ["AADHAAR_FRONT", "AADHAAR", "AADHAAR_BACK"];
    if (base === "AADHAAR_BACK") return ["AADHAAR_BACK", "AADHAAR", "AADHAAR_FRONT"];
    return [base];
  })();

  const makeFormData = (documentType) => {
    const fd = new FormData();
    fd.append("verification_id", verificationId);
    fd.append("document_type", documentType);
    fd.append("file", new Blob([fileBuffer], { type: mimeType }), safeFilename);
    return fd;
  };

  let cashfreeResponse;
  let sentDocumentType = documentTypeCandidates[0] || requestedDocumentTypeRaw || "AADHAAR_FRONT";
  try {
    let lastStatus = 500;
    for (const dt of documentTypeCandidates) {
      sentDocumentType = dt;
      const resp = await fetch(`${CASHFREE_VERIFICATION_BASE_URL}/bharat-ocr`, {
        method: "POST",
        headers: {
          "x-api-version": CASHFREE_API_VERSION,
          "x-client-id": CASHFREE_CLIENT_ID,
          "x-client-secret": CASHFREE_CLIENT_SECRET,
        },
        body: makeFormData(dt),
      });

      lastStatus = resp.status || 500;
      cashfreeResponse = await resp.json().catch(() => null);
      if (resp.ok) break;

      const code = String(cashfreeResponse?.code || "").toLowerCase();
      if (code !== "document_type_invalid") break;
    }

    if (!cashfreeResponse || String(cashfreeResponse?.code || "").toLowerCase() === "document_type_invalid") {
      return res.status(400).json({
        success: false,
        provider: "cashfree_bharat_ocr",
        apiVersion: CASHFREE_API_VERSION,
        documentTypeSent: sentDocumentType,
        cashfreeResponse,
        aadharVerified: false,
        mismatchReasons: [
          cashfreeResponse?.message ||
            cashfreeResponse?.error ||
            cashfreeResponse?.code ||
            "Failed to verify Aadhaar via Cashfree",
        ],
        fileReceived,
      });
    }

    const statusStr = String(cashfreeResponse?.status || "").toUpperCase();
    if (statusStr !== "VALID" && statusStr !== "INVALID" && statusStr !== "REJECTED" && statusStr !== "PENDING") {
      return res.status(lastStatus || 500).json({
        success: false,
        provider: "cashfree_bharat_ocr",
        apiVersion: CASHFREE_API_VERSION,
        documentTypeSent: sentDocumentType,
        cashfreeResponse,
        aadharVerified: false,
        mismatchReasons: [
          cashfreeResponse?.message ||
            cashfreeResponse?.error ||
            cashfreeResponse?.code ||
            "Failed to verify Aadhaar via Cashfree",
        ],
        fileReceived,
      });
    }
  } catch (err) {
    if (err?.status && err?.message) throw err;
    throw createError(500, err?.message || "Failed to verify Aadhaar via Cashfree");
  }

  const normalizeDigits = (val) => (val ?? "").toString().replace(/\D/g, "");
  const normalizeName = (val) => (val ?? "").toString().trim().toLowerCase().replace(/\s+/g, " ");
  const normalizeDate = (val) => {
    const s = (val ?? "").toString().trim();
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    return "";
  };

  const inputAadharDigits = normalizeDigits(inputAadharNumber);
  const documentFields = cashfreeResponse?.document_fields || {};

  const docAadharRaw =
    documentFields?.aadhaar_number ??
    documentFields?.aadhar_number ??
    documentFields?.aadhaar ??
    documentFields?.document_number ??
    documentFields?.id_number ??
    documentFields?.uid ??
    documentFields?.uid_number;
  const docAadharDigits = normalizeDigits(docAadharRaw);

  const docNameRaw = documentFields?.name ?? documentFields?.full_name ?? documentFields?.holder_name;
  const docName = normalizeName(docNameRaw);

  const docDobRaw = documentFields?.dob ?? documentFields?.date_of_birth ?? documentFields?.birth_date;
  const docDob = normalizeDate(docDobRaw);

  let aadharNumberMatch = true;
  let nameMatch = true;
  let dobMatch = true;
  const mismatchReasons = [];

  if (docAadharDigits.length === 12) {
    aadharNumberMatch = docAadharDigits === inputAadharDigits;
  } else if (docAadharDigits.length >= 4) {
    aadharNumberMatch = inputAadharDigits.endsWith(docAadharDigits);
  } else {
    aadharNumberMatch = false;
  }
  if (!aadharNumberMatch) mismatchReasons.push("Aadhar number does not match");

  if (playerId) {
    const player = await prisma.player.findUnique({
      where: { id: playerId },
      select: {
        firstName: true,
        lastName: true,
        dateOfBirth: true,
        aadharNumber: true,
        clubId: true,
      },
    });
    if (!player) throw createError(404, "Player not found");

    const role = String(req.user?.role || "").toLowerCase();
    const clubIdFromUser = await resolveClubIdFromReqUser(req);
    if (role !== "admin" && clubIdFromUser && player.clubId && player.clubId !== clubIdFromUser) {
      throw createError(403, "Forbidden");
    }

    const playerAadharDigits = normalizeDigits(player.aadharNumber);
    if (playerAadharDigits && inputAadharDigits && playerAadharDigits !== inputAadharDigits) {
      aadharNumberMatch = false;
      if (!mismatchReasons.includes("Aadhar number does not match")) {
        mismatchReasons.push("Aadhar number does not match");
      }
    }

    if (!docName) {
      nameMatch = false;
      mismatchReasons.push("Name does not match");
    } else {
      const docTokens = docName.split(" ");
      const firstMatch = player.firstName ? docTokens.includes(String(player.firstName).toLowerCase()) : false;
      const lastMatch = player.lastName ? docTokens.includes(String(player.lastName).toLowerCase()) : false;
      nameMatch = firstMatch && lastMatch;
      if (!nameMatch) mismatchReasons.push("Name does not match");
    }

    if (!docDob) {
      dobMatch = false;
      mismatchReasons.push("Date of birth does not match");
    } else {
      const playerDobStr = player.dateOfBirth ? player.dateOfBirth.toISOString().split("T")[0] : "";
      dobMatch = !!playerDobStr && playerDobStr === docDob;
      if (!dobMatch) mismatchReasons.push("Date of birth does not match");
    }
  } else {
    if (!docName) {
      nameMatch = false;
      mismatchReasons.push("Name does not match");
    }
    if (!docDob) {
      dobMatch = false;
      mismatchReasons.push("Date of birth does not match");
    }
  }

  const ocrStatus = String(
    cashfreeResponse?.status || cashfreeResponse?.verification_status || cashfreeResponse?.ocr_status || ""
  ).toUpperCase();
  const ocrValid = ocrStatus === "VALID";

  const allMatch = aadharNumberMatch && nameMatch && dobMatch;
  const aadharVerified = ocrValid && allMatch;

  if (playerId && aadharVerified) {
    await prisma.player.update({
      where: { id: playerId },
      data: { aadharVerified: true },
    });
  }

  return res.status(200).json({
    success: true,
    provider: "cashfree_bharat_ocr",
    apiVersion: CASHFREE_API_VERSION,
    documentTypeSent: sentDocumentType,
    cashfreeResponse,
    aadharVerified,
    mismatchReasons,
    fileReceived,
    aadharNumberMatch,
    nameMatch,
    dobMatch,
    allMatch,
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
  exportPlayersPDF,
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