const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");
const express = require("express");

const router = express.Router();
//yash
const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Node-Star API",
      version: "1.0.0",
      description: "A simple Node.js REST API.",
    },
    servers: [
      {
        url: "http://15.207.30.113/",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
  },
  apis: ["./src/routes/*.js"],
};

const specs = swaggerJsdoc(options);

const swaggerUiOptions = {
  swaggerOptions: {
    requestInterceptor: (req) => {
      // Ensure content-type is properly set for file uploads
      if (req.body instanceof FormData) {
        req.headers["Content-Type"] = "multipart/form-data";
      }
      return req;
    },
  },
};

router.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(specs, swaggerUiOptions)
);

module.exports = router;
