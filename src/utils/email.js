const nodemailer = require("nodemailer");
require("dotenv").config();

// Initialize Nodemailer transporter
let transporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
}

/**
 * Sends an email using the best available method:
 * 1. Resend HTTP API (unblocked on Render Free tier)
 * 2. Brevo HTTP API (unblocked on Render Free tier)
 * 3. Nodemailer SMTP (works on Localhost/paid servers)
 */
const sendEmail = async ({ to, subject, html }) => {
  // Option 1: Resend HTTP API
  if (process.env.RESEND_API_KEY) {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || "Chugli App <onboarding@resend.dev>",
          to,
          subject,
          html,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || `Resend API returned status ${response.status}`);
      }
      console.log("Email sent successfully via Resend API:", data);
      return data;
    } catch (error) {
      console.error("Failed to send email via Resend API:", error);
      throw error;
    }
  }

  // Option 2: Brevo HTTP API
  if (process.env.BREVO_API_KEY) {
    try {
      const response = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "accept": "application/json",
          "api-key": process.env.BREVO_API_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sender: { name: "Chugli App", email: process.env.EMAIL_USER || "no-reply@chugli.app" },
          to: [{ email: to }],
          subject,
          htmlContent: html,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || `Brevo API returned status ${response.status}`);
      }
      console.log("Email sent successfully via Brevo API:", data);
      return data;
    } catch (error) {
      console.error("Failed to send email via Brevo API:", error);
      throw error;
    }
  }

  // Option 3: Nodemailer SMTP (Fallback)
  if (transporter) {
    try {
      const info = await transporter.sendMail({
        from: `"Chugli App" <${process.env.EMAIL_USER}>`,
        to,
        subject,
        html,
      });
      console.log("Email sent successfully via SMTP:", info.messageId);
      return info;
    } catch (error) {
      console.error("Failed to send email via SMTP:", error);
      throw error;
    }
  }

  throw new Error("No email service configured. Please set RESEND_API_KEY, BREVO_API_KEY, or EMAIL_USER/EMAIL_PASS.");
};

module.exports = { sendEmail };
