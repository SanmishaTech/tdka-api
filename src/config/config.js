module.exports = {
  appName: process.env.APP_NAME || "CrediSphere",
  defaultUserRole: process.env.DEFAULT_USER_ROLE || "user",
  allowRegistration: process.env.ALLOW_REGISTRATION || true,
  frontendUrl: process.env.FRONTEND_URL || "localhost:5173",
};
