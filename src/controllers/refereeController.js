const prisma = require("../config/db");
const bcrypt = require("bcrypt");
const { z } = require("zod");

const ensureRefereeDelegate = (res) => {
  if (!prisma || !prisma.referee) {
    res.status(500).json({
      errors: {
        message:
          "Prisma Client is missing the Referee model. Run `npx prisma generate` (ensure backend is not running) and restart the server.",
      },
    });
    return false;
  }
  return true;
};

const getReferees = async (req, res, next) => {
  if (!ensureRefereeDelegate(res)) return;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;
  const search = req.query.search || "";
  const sortBy = req.query.sortBy || "createdAt";
  const sortOrder = req.query.sortOrder === "desc" ? "desc" : "asc";

  const sortableFields = [
    "id",
    "firstName",
    "middleName",
    "lastName",
    "emailId",
    "contactNumber",
    "createdAt",
  ];
  const safeSortBy = sortableFields.includes(sortBy) ? sortBy : "createdAt";

  const whereClause = search
    ? {
        OR: [
          { firstName: { contains: search } },
          { middleName: { contains: search } },
          { lastName: { contains: search } },
          { emailId: { contains: search } },
          { contactNumber: { contains: search } },
        ],
      }
    : {};

  try {
    const referees = await prisma.referee.findMany({
      where: whereClause,
      skip,
      take: limit,
      orderBy: { [safeSortBy]: sortOrder },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            active: true,
          },
        },
      },
    });

    const totalReferees = await prisma.referee.count({ where: whereClause });

    const totalPages = Math.ceil(totalReferees / limit);

    res.json({
      referees,
      page,
      totalPages,
      totalReferees,
    });
  } catch (error) {
    next(error);
  }
};

const getRefereeById = async (req, res, next) => {
  if (!ensureRefereeDelegate(res)) return;
  try {
    const refereeId = parseInt(req.params.id);
    const referee = await prisma.referee.findUnique({
      where: { id: refereeId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            active: true,
          },
        },
      },
    });

    if (!referee) {
      return res.status(404).json({
        errors: { message: "Referee not found." },
      });
    }

    res.json(referee);
  } catch (error) {
    next(error);
  }
};

const createReferee = async (req, res, next) => {
  if (!ensureRefereeDelegate(res)) return;
  const optionalInt = () =>
    z.preprocess(
      (val) => {
        if (val === "" || val === null || val === undefined) return undefined;
        const num = Number(val);
        return Number.isNaN(num) ? undefined : num;
      },
      z.number().int().optional()
    );

  const optionalDate = () =>
    z.preprocess(
      (val) => {
        if (!val) return undefined;
        const d = new Date(val);
        return Number.isNaN(d.getTime()) ? undefined : d;
      },
      z.date().optional()
    );

  const schema = z.object({
    firstName: z.string().optional(),
    middleName: z.string().optional(),
    lastName: z.string().optional(),
    address: z.string().optional(),
    pincode: z.string().optional(),
    contactNumber: z.string().optional(),
    emailId: z
      .string()
      .email("Email must be a valid email address.")
      .nonempty("Email is required.")
      .refine(
        async (emailId) => {
          const existingUser = await prisma.user.findUnique({ where: { email: emailId } });
          const existingReferee = await prisma.referee.findUnique({ where: { emailId } });
          return !existingUser && !existingReferee;
        },
        { message: "A user with this email already exists." }
      ),
    dateOfBirth: optionalDate(),
    bloodGroup: z.string().optional(),
    zillaParishadPassYear: optionalInt(),
    statePanchayatPassYear: optionalInt(),
    allIndiaPanchayatPassYear: optionalInt(),
    officeAddress: z.string().optional(),
    officePincode: z.string().optional(),
    officeContactNumber: z.string().optional(),
    password: z.string().min(6, "Password must be at least 6 characters long."),
  });

  let parsed;
  try {
    parsed = await schema.parseAsync(req.body);
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
    return next(error);
  }

  try {
    const {
      password,
      firstName,
      middleName,
      lastName,
      address,
      pincode,
      contactNumber,
      emailId,
      dateOfBirth,
      bloodGroup,
      zillaParishadPassYear,
      statePanchayatPassYear,
      allIndiaPanchayatPassYear,
      officeAddress,
      officePincode,
      officeContactNumber,
    } = parsed;

    const hashedPassword = await bcrypt.hash(password, 10);
    const fullName = [firstName, middleName, lastName].filter(Boolean).join(" ").trim() || "Referee";

    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: fullName,
          email: emailId,
          password: hashedPassword,
          role: "referee",
          active: true,
        },
        select: { id: true, email: true, active: true },
      });

      const referee = await tx.referee.create({
        data: {
          userId: user.id,
          firstName,
          middleName,
          lastName,
          address,
          pincode,
          contactNumber,
          emailId,
          dateOfBirth,
          bloodGroup,
          zillaParishadPassYear,
          statePanchayatPassYear,
          allIndiaPanchayatPassYear,
          officeAddress,
          officePincode,
          officeContactNumber,
        },
        include: { user: { select: { id: true, email: true, active: true } } },
      });

      return referee;
    });

    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
};

const updateReferee = async (req, res, next) => {
  if (!ensureRefereeDelegate(res)) return;
  const refereeId = parseInt(req.params.id);

  try {
    const existingReferee = await prisma.referee.findUnique({
      where: { id: refereeId },
      include: { user: { select: { id: true, email: true, active: true } } },
    });

    if (!existingReferee) {
      return res.status(404).json({
        errors: { message: "Referee not found." },
      });
    }

    const optionalInt = () =>
      z.preprocess(
        (val) => {
          if (val === "" || val === null || val === undefined) return undefined;
          const num = Number(val);
          return Number.isNaN(num) ? undefined : num;
        },
        z.number().int().optional()
      );

    const optionalDate = () =>
      z.preprocess(
        (val) => {
          if (!val) return undefined;
          const d = new Date(val);
          return Number.isNaN(d.getTime()) ? undefined : d;
        },
        z.date().optional()
      );

    const passwordSchema = z.preprocess(
      (val) => (val === "" || val === null || val === undefined ? undefined : val),
      z.string().min(6, "Password must be at least 6 characters long.").optional()
    );

    const schema = z
      .object({
        firstName: z.string().min(1, "First name is required.").optional(),
        middleName: z.string().optional(),
        lastName: z.string().min(1, "Last name is required.").optional(),
        address: z.string().optional(),
        pincode: z.string().optional(),
        contactNumber: z.string().min(1, "Contact number is required.").optional(),
        emailId: z
          .string()
          .email("Email must be a valid email address.")
          .optional(),
        dateOfBirth: optionalDate(),
        bloodGroup: z.string().optional(),
        zillaParishadPassYear: optionalInt(),
        statePanchayatPassYear: optionalInt(),
        allIndiaPanchayatPassYear: optionalInt(),
        officeAddress: z.string().optional(),
        officePincode: z.string().optional(),
        officeContactNumber: z.string().optional(),
        password: passwordSchema,
      })
      .refine(
        (data) =>
          Object.keys(data).some(
            (k) => data[k] !== undefined && data[k] !== null && data[k] !== ""
          ),
        { message: "At least one field must be provided" }
      )
      .superRefine(async (data, ctx) => {
        if (data.emailId) {
          const existingUser = await prisma.user.findUnique({
            where: { email: data.emailId },
            select: { id: true },
          });
          if (existingUser && existingUser.id !== existingReferee.userId) {
            ctx.addIssue({
              path: ["emailId"],
              message: `User with email ${data.emailId} already exists.`,
            });
          }

          const existingProfile = await prisma.referee.findUnique({
            where: { emailId: data.emailId },
            select: { id: true },
          });
          if (existingProfile && existingProfile.id !== refereeId) {
            ctx.addIssue({
              path: ["emailId"],
              message: `User with email ${data.emailId} already exists.`,
            });
          }
        }
      });

    let parsed;
    try {
      parsed = await schema.parseAsync(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errors = {};
        error.errors.forEach((err) => {
          errors[err.path[0] || "form"] = {
            type: "validation",
            message: err.message,
          };
        });
        return res.status(400).json({ errors });
      }
      return next(error);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const nextFirstName = parsed.firstName ?? existingReferee.firstName;
      const nextMiddleName = parsed.middleName ?? existingReferee.middleName;
      const nextLastName = parsed.lastName ?? existingReferee.lastName;
      const fullName = [nextFirstName, nextMiddleName, nextLastName].filter(Boolean).join(" ").trim() || "Referee";

      const userUpdateData = {};
      if (parsed.emailId) userUpdateData.email = parsed.emailId;
      if (parsed.password) userUpdateData.password = await bcrypt.hash(parsed.password, 10);
      userUpdateData.name = fullName;

      await tx.user.update({
        where: { id: existingReferee.userId },
        data: userUpdateData,
      });

      const refereeUpdateData = {};
      [
        "firstName",
        "middleName",
        "lastName",
        "address",
        "pincode",
        "contactNumber",
        "emailId",
        "dateOfBirth",
        "bloodGroup",
        "zillaParishadPassYear",
        "statePanchayatPassYear",
        "allIndiaPanchayatPassYear",
        "officeAddress",
        "officePincode",
        "officeContactNumber",
      ].forEach((key) => {
        if (parsed[key] !== undefined) refereeUpdateData[key] = parsed[key];
      });

      const referee = await tx.referee.update({
        where: { id: refereeId },
        data: refereeUpdateData,
        include: { user: { select: { id: true, email: true, active: true } } },
      });

      return referee;
    });

    res.json(updated);
  } catch (error) {
    if (error.code === "P2025") {
      return res.status(404).json({
        errors: { message: "Referee not found." },
      });
    }
    next(error);
  }
};

const deleteReferee = async (req, res, next) => {
  if (!ensureRefereeDelegate(res)) return;
  try {
    const refereeId = parseInt(req.params.id);

    const referee = await prisma.referee.findUnique({
      where: { id: refereeId },
      select: { id: true, userId: true },
    });

    if (!referee) {
      return res.status(404).json({
        errors: { message: "Referee not found." },
      });
    }

    await prisma.user.delete({ where: { id: referee.userId } });

    res.json({ message: "Referee deleted successfully." });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getReferees,
  getRefereeById,
  createReferee,
  updateReferee,
  deleteReferee,
};
