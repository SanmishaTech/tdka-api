const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const { z } = require("zod");
const prisma = require("../config/db");
const emailService = require("../services/emailService");
const validateRequest = require("../utils/validateRequest");
const config = require("../config/config");
const createError = require("http-errors");
const jwtConfig = require("../config/jwt");
const { SUPER_ADMIN } = require("../config/roles");

// Register a new user
const register = async (req, res, next) => {
  if (process.env.ALLOW_REGISTRATION !== "true") {
    return res
      .status(403)
      .json({ errors: { message: "Registration is disabled" } });
  }

  // Define Zod schema for registration validation
  const schema = z
    .object({
      name: z.string().nonempty("Name is required."),
      email: z
        .string()
        .email("Email must be a valid email address.")
        .nonempty("Email is required."),
      password: z
        .string()
        .min(6, "Password must be at least 6 characters long.")
        .nonempty("Password is required."),
    })
    .superRefine(async (data, ctx) => {
      // Check if a user with the same email already exists
      const existingUser = await prisma.user.findUnique({
        where: { email: data.email },
      });

      if (existingUser) {
        ctx.addIssue({
          path: ["email"],
          message: `User with email ${data.email} already exists.`,
        });
      }
    });

  try {
    // Use the reusable validation function
    const validationErrors = await validateRequest(schema, req.body, res);
    const { name, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: config.defaultUserRole,
      },
    });

    res.status(201).json(user);
  } catch (error) {
    next(error);
  }
};

const login = async (req, res, next) => {
  const schema = z.object({
    email: z.string().email("Invalid Email format").min(1, "email is required"),
    password: z.string().min(6, "Password must be at least 6 characters long"),
  });

  try {
    const validationErrors = await validateRequest(schema, req.body, res);
    const { email, password } = req.body;
    
    console.log("Login attempt for email:", email);



    // Find user by email first
    let user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        name: true,
        email: true,
        password: true,
        role: true,
        active: true,
        lastLogin: true,
        clubId: true,
      },
    });

    let isClub = false;
    let clubId = null;
    
    // If not found in users, check clubs
    if (!user) {
      const club = await prisma.club.findFirst({
        where: { email },
        select: {
          id: true,
          clubName: true,
          email: true,
          password: true,
        },
      });
      
      if (club) {
        // Transform club data to match user structure
        user = {
          id: club.id,
          name: club.clubName,
          email: club.email,
          password: club.password,
          role: "CLUB",
          active: true,
          lastLogin: null,
          clubId: club.id, // Set clubId to the club's own ID
        };
        isClub = true;
        clubId = club.id;
      }
    } else if (user.clubId) {
      // If user has a clubId, store it
      clubId = user.clubId;
    }

    if (!user) {
      return res
        .status(401)
        .json({ errors: { message: "Invalid email or password" } });
    }

    // Handle password verification
    if (!(await bcrypt.compare(password, user.password))) {
      return res
        .status(401)
        .json({ errors: { message: "Invalid email or password" } });
    }

    if (!user.active) {
      return res
        .status(403)
        .json({ errors: { message: "Account is inactive" } });
    }

    // If the user is an observer, enforce login time window
    if (typeof user.role === "string" && user.role.toLowerCase() === "observer") {
      const competitions = await prisma.competition.findMany({
        where: { observerId: user.id },
        select: { id: true, fromDate: true, toDate: true },
      });

      if (!competitions || competitions.length === 0) {
        return res
          .status(403)
          .json({ errors: { message: "Observer is not assigned to any competition" } });
      }

      const now = new Date();

      const ranges = competitions
        .map((c) => {
          const start = new Date(c.fromDate);
          const end = new Date(c.toDate);
          if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
          start.setHours(0, 0, 0, 0);
          end.setHours(23, 59, 59, 999);
          return { start, end, c };
        })
        .filter(Boolean);

      if (ranges.length === 0) {
        return res
          .status(500)
          .json({ errors: { message: "Invalid competition date configuration for observer access" } });
      }

      const anyActive = ranges.some(({ start, end }) => now >= start && now <= end);
      if (!anyActive) {
        // Find next upcoming start, if any
        const upcoming = ranges
          .filter(({ start }) => start > now)
          .sort((a, b) => a.start.getTime() - b.start.getTime());

        if (upcoming.length > 0) {
          return res
            .status(403)
            .json({ errors: { message: `Observer access not yet active. Starts on ${upcoming[0].c.fromDate}` } });
        }
        return res
          .status(403)
          .json({ errors: { message: "Observer access period has expired" } });
      }
    }

    // If the user is a referee, enforce login time window
    if (typeof user.role === "string" && user.role.toLowerCase() === "referee") {
      const competitions = await prisma.competition.findMany({
        where: { refereeId: user.id },
        select: { id: true, fromDate: true, toDate: true },
      });

      if (!competitions || competitions.length === 0) {
        return res
          .status(403)
          .json({ errors: { message: "Referee is not assigned to any competition" } });
      }

      const now = new Date();

      const ranges = competitions
        .map((c) => {
          const start = new Date(c.fromDate);
          const end = new Date(c.toDate);
          if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
          start.setHours(0, 0, 0, 0);
          end.setHours(23, 59, 59, 999);
          return { start, end, c };
        })
        .filter(Boolean);

      if (ranges.length === 0) {
        return res
          .status(500)
          .json({ errors: { message: "Invalid competition date configuration for referee access" } });
      }

      const anyActive = ranges.some(({ start, end }) => now >= start && now <= end);
      if (!anyActive) {
        const upcoming = ranges
          .filter(({ start }) => start > now)
          .sort((a, b) => a.start.getTime() - b.start.getTime());

        if (upcoming.length > 0) {
          return res
            .status(403)
            .json({ errors: { message: `Referee access not yet active. Starts on ${upcoming[0].c.fromDate}` } });
        }
        return res
          .status(403)
          .json({ errors: { message: "Referee access period has expired" } });
      }
    }

    const token = jwt.sign({ userId: user.id, isClub }, jwtConfig.secret, {
      expiresIn: jwtConfig.expiresIn,
    });

    // Update lastLogin timestamp only for users
    if (!isClub) {
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLogin: new Date() },
      });
    }

    // Remove password from response
    const { password: _, ...userWithoutPassword } = user;

    res.json({
      token,
      user: userWithoutPassword,
      clubId, // Include clubId in the response for frontend to store in localStorage
    });
  } catch (error) {
    next(error);
  }
};

const forgotPassword = async (req, res, next) => {
  const schema = z.object({
    email: z
      .string()
      .email("Invalid Email format")
      .nonempty("Email is required"),
  });
  console.log("Forgot password request:", req.body);

  try {
    const validationErrors = await validateRequest(schema, req.body, res);
    const { email, resetUrl } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return setTimeout(() => {
        res.status(404).json({ errors: { message: "User not found" } });
      }, 3000);
    }

    const resetToken = uuidv4();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetToken,
        resetTokenExpires: new Date(Date.now() + 3600000), // Token expires in 1 hour
      },
    });
    const resetLink = `${resetUrl}/${resetToken}`; // Replace with your actual domain
    const templateData = {
      name: user.name,
      resetLink,
      appName: config.appName,
    };
    await emailService.sendEmail(
      email,
      "Password Reset Request",
      "passwordReset",
      templateData
    );

    res.json({ message: "Password reset link sent" });
  } catch (error) {
    next(error);
  }
};

const resetPassword = async (req, res, next) => {
  console.log("Reset password request:", req.body);
  const schema = z.object({
    password: z.string().min(6, "Password must be at least 6 characters long"),
  });

  try {
    // Use the reusable validation function
    const validationErrors = await validateRequest(schema, req.body, res);
    const { password } = req.body;
    const { token } = req.body;

    const user = await prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExpires: { gt: new Date() }, // Check if the token is not expired
      },
    });

    if (!user) {
      return res
        .status(400)
        .json({ errors: { message: "Invalid or expired token" } });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetToken: null, // Clear the token after use
        resetTokenExpires: null,
      },
    });
    res.json({ message: "Password reset successful" });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  register,
  login,
  forgotPassword,
  resetPassword,
};
