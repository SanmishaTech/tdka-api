const nodemailer = require("nodemailer");
const sgMail = require("@sendgrid/mail");
const fs = require("fs");
const path = require("path");
const ejs = require("ejs");

let transporter;

// Configure the transporter based on the EMAIL_TRANSPORTER environment variable
switch (process.env.EMAIL_TRANSPORTER) {
  case "sendgrid":
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    break;
  case "mailtrap":
    transporter = nodemailer.createTransport({
      host: process.env.MAILTRAP_HOST,
      port: process.env.MAILTRAP_PORT,
      auth: {
        user: process.env.MAILTRAP_USER,
        pass: process.env.MAILTRAP_PASSWORD,
      },
    });
    break;
  case "smtp":
  default:
    transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: process.env.EMAIL_PORT,
      secure: process.env.EMAIL_PORT === "465", // true for 465, false for other ports
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
      },
    });
    break;
}

// Function to read and compile the EJS template
const compileTemplate = (templateName, data) => {
  const filePath = path.join(
    __dirname,
    "..",
    "templates",
    `${templateName}.ejs`
  );
  const source = fs.readFileSync(filePath, "utf8");
  return ejs.render(source, data);
};

const sendEmail = async (to, subject, templateName, templateData) => {
  const html = compileTemplate(templateName, templateData);

  const mailOptions = {
    from: process.env.EMAIL_FROM,
    to,
    subject,
    html,
  };

  try {
    if (process.env.EMAIL_TRANSPORTER === "sendgrid") {
      // Send email using SendGrid
      await sgMail.send(mailOptions);
      console.log("Email sent successfully using SendGrid");
    } else {
      // Send email using SMTP or Mailtrap
      await transporter.sendMail(mailOptions);
    }
  } catch (error) {
    console.error("Error sending email:", error);
    throw error;
  }
};

module.exports = { sendEmail };
