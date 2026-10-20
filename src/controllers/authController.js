// const { model } = require("mongoose");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/User");
const { sendEmail } = require("../utils/email");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const createToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
};

const generateRefreshToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: "90d",
  });
};
//` Refresh Token Handler
const refreshTokenHandler = async (req, res) => {
  try {
    const token = req.cookies.refreshToken;

    if (!token) {
      return res.status(401).json({ message: "No refresh token" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    const newAccessToken = createToken(user._id);

    res.status(200).json({ token: newAccessToken });
  } catch (error) {
    console.error("Refresh token error:", error);

    return res.status(401).json({
      message: "Refresh token expired",
    });
  }
};

const googleAuth = async (req, res) => {
  try {
    const { token, username: desiredUsername } = req.body; // token from frontend (Google)
    if (!token) return res.status(400).json({ message: "No token provided" });

    // 1️⃣ Verify Google token
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const { email, name, picture, email_verified } = ticket.getPayload();

    // 2️⃣ Ensure the Google account email is verified
    if (!email_verified) {
      return res.status(403).json({ message: "Email not verified by Google" });
    }

    // 3️⃣ Check if the user already exists
    let user = await User.findOne({ email: email.toLowerCase().trim() });

    // If user exists: login directly
    if (user) {
      if (!user.isVerified) {
        user.isVerified = true;
      }
      if (!user.name && name) {
        user.name = name.trim();
      }

      // If old user does not have self-friend, fix it
      if (!user.friends.includes(user._id)) {
        user.friends.push(user._id);
      }

      await user.save();
    } else {
      // Brand new Google user: Check if a unique username was supplied
      if (!desiredUsername || !desiredUsername.trim()) {
        // Do NOT auto-generate a username. Prompt the client for a unique username popup.
        return res.status(200).json({
          requiresUsername: true,
          email,
          name: name || "User",
          picture,
          googleToken: token,
          message: "Please choose your permanent username to complete registration.",
        });
      }

      // Validate the chosen permanent username
      const cleanUsername = desiredUsername.toLowerCase().trim();
      const usernameRegex = /^[a-z0-9_]{3,30}$/;
      if (!usernameRegex.test(cleanUsername)) {
        return res.status(400).json({
          message: "Username must be 3-30 characters long and contain only letters, numbers, and underscores.",
        });
      }

      const usernameExists = await User.findOne({ username: cleanUsername });
      if (usernameExists) {
        return res.status(400).json({ message: "Username is already taken. Please choose another." });
      }

      // Create new user with chosen username & Google display name
      user = await User.create({
        username: cleanUsername,
        name: (req.body.name || name || cleanUsername).trim(),
        email: email.toLowerCase().trim(),
        password: "GOOGLE_AUTH_USER",
        profilePic: picture,
        isVerified: true,
      });

      // MAKE USER FRIEND OF HIMSELF
      user.friends = [user._id];
      await user.save();
    }

    // 4️⃣ Generate JWT for our app
    const appToken = createToken(user._id);
    const refreshToken = generateRefreshToken(user._id);
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: true, // true on Render
      sameSite: "none", // required for Netlify ↔ Render
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      message: "Google authentication successful",
      token: appToken,
      userId: user._id,
      user: {
        _id: user._id,
        username: user.username,
        name: user.name,
        email: user.email,
        profilePic: user.profilePic,
        about: user.about,
      },
    });
  } catch (error) {
    console.error("Google Auth Error:", error);
    res.status(500).json({ message: error.message });
  }
};

const signup = async (req, res) => {
  const { username, name, email, password } = req.body;

  try {
    // 1️⃣ Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      return res.status(400).json({ message: "Please enter a valid email address" });
    }

    const emailExists = await User.findOne({ email: email.toLowerCase().trim() });
    if (emailExists) {
      return res.status(400).json({ message: "Email is already registered" });
    }

    // 2️⃣ Validate username format & uniqueness
    if (!username || !username.trim()) {
      return res.status(400).json({ message: "Username is required" });
    }

    const cleanUsername = username.toLowerCase().trim();
    const usernameRegex = /^[a-z0-9_]{3,30}$/;
    if (!usernameRegex.test(cleanUsername)) {
      return res.status(400).json({
        message: "Username must be 3-30 characters long and contain only letters, numbers, and underscores.",
      });
    }

    const usernameExists = await User.findOne({ username: cleanUsername });
    if (usernameExists) {
      return res.status(400).json({ message: "Username is already taken. Please choose another." });
    }

    // 3️⃣ Validate display name
    const displayName = (name && name.trim()) ? name.trim() : cleanUsername;
    if (displayName.length > 50) {
      return res.status(400).json({ message: "Display name cannot exceed 50 characters" });
    }

    // 4️⃣ Create verified user
    const user = await User.create({
      username: cleanUsername,
      name: displayName,
      email: email.toLowerCase().trim(),
      password,
      isVerified: true,
    });

    // MAKE USER FRIEND OF HIMSELF
    user.friends = [user._id];
    await user.save();

    // 5️⃣ Generate JWT for direct app entry
    const token = createToken(user._id);
    const refreshToken = generateRefreshToken(user._id);
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: true, // true on Render
      sameSite: "none", // required for Netlify ↔ Render
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    res.status(201).json({
      message: "User registered successfully!",
      token,
      userId: user._id,
      user: {
        _id: user._id,
        username: user.username,
        name: user.name,
        email: user.email,
        profilePic: user.profilePic,
        about: user.about,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 🧩 2️⃣ VERIFY EMAIL ROUTE
const verifyEmail = async (req, res) => {
  console.log("Verifying email...");
  // console.log("Request params:", req.params);
  const { token } = req.params;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // const user = await User.findById(decoded.userId);
    const { username, email, password } = decoded;

    // console.log("Decoded Token:", decoded);
    // console.log("User by id:", user);

    let existingUser = await User.findOne({ email });

    if (existingUser && existingUser.isVerified) {
      // console.log("⚠️ User already verified:", email);
      // Redirect to frontend with info
      return res.redirect(
        `${process.env.CLIENT_URL}/pages/login?verified=already`
      );
    }

    // if (existingUser) {
    //   return res
    //     .status(400)
    //     .send("<h2>Email already verified or user exists.</h2>");
    // }

    // const user = await User.create({
    //   username,
    //   email,
    //   password,
    //   isVerified: true,
    // });
    // await user.save();

    // 3️⃣ If user doesn’t exist → create verified user
    if (!existingUser) {
      existingUser = await User.create({
        username,
        email,
        password,
        isVerified: true,
      });

      // MAKE USER FRIEND OF HIMSELF
      existingUser.friends = [existingUser._id];
      await existingUser.save();

      // console.log("✅ Created verified user:", email);
    } else {
      // Update existing record to verified
      existingUser.isVerified = true;
      // FIX MISSING SELF-FRIEND
      if (!existingUser.friends.includes(existingUser._id)) {
        existingUser.friends.push(existingUser._id);
      }

      await existingUser.save();
      // console.log("✅ Marked existing user as verified:", email);
    }

    // 4️⃣ Create JWT token for login
    const appToken = createToken(existingUser._id);
    const refreshToken = generateRefreshToken(existingUser._id);
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: true, // true on Render
      sameSite: "none", // required for Netlify ↔ Render
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    // 5️⃣ Redirect user to frontend with token (auto-login)
    const redirectURL = `${process.env.CLIENT_URL}/?token=${appToken}`;

    // console.log("🔗 Redirecting user to:", redirectURL);
    return res.status(302).redirect(redirectURL);

    // if (!user) return res.status(404).send("<h2>User not found</h2>");
    // if (user.isVerified)
    //   return res.status(400).send("<h2>Email already verified</h2>");

    // user.isVerified = true;
    // await user.save();

    // res.status(200).send(`
    //   <div style="font-family:sans-serif;text-align:center;margin-top:50px;">
    //     <h2>✅ Email verified successfully!</h2>
    //     <p>You can now close this tab and log in to your Chugli account.</p>
    //   </div>
    // `);
  } catch (error) {
    console.error("Email Verification Error:", error);
    if (!res.headersSent) {
      res
        .status(302)
        .redirect(`${process.env.CLIENT_URL}/pages/login?verified=failed`);
    }
    // res.redirect(`${process.env.CLIENT_URL}/pages/login?verified=failed`);
    // res.status(400).send("<h2>❌ Invalid or expired verification link.</h2>");
  }
};

// 🔍 CHECK USERNAME AVAILABILITY & VALIDITY
const checkUsername = async (req, res) => {
  try {
    const rawUsername = req.query.username || req.body.username;
    if (!rawUsername || !rawUsername.trim()) {
      return res.status(400).json({ available: false, message: "Username is required." });
    }

    const cleanUsername = rawUsername.toLowerCase().trim();
    const usernameRegex = /^[a-z0-9_]{3,30}$/;
    if (!usernameRegex.test(cleanUsername)) {
      return res.status(400).json({
        available: false,
        message: "Username must be 3-30 characters long and contain only lowercase letters, numbers, and underscores.",
      });
    }

    const existing = await User.findOne({ username: cleanUsername });
    if (existing) {
      return res.status(200).json({
        available: false,
        message: "Username is already taken.",
      });
    }

    return res.status(200).json({
      available: true,
      message: "Username is available.",
      username: cleanUsername,
    });
  } catch (error) {
    console.error("Check username error:", error);
    return res.status(500).json({ message: "Server error checking username." });
  }
};

// ✅ LOGIN ROUTE
const login = async (req, res) => {
  const { username, password } = req.body;

  try {
    if (!username || !password) {
      return res.status(400).json({ message: "Username/Email and password are required" });
    }

    const loginIdentifier = username.trim();
    const escapedIdentifier = loginIdentifier.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');

    const user = await User.findOne({
      $or: [
        { username: { $regex: new RegExp(`^${escapedIdentifier}$`, "i") } },
        { email: loginIdentifier.toLowerCase() },
      ],
    });
    if (!user) {
      return res.status(400).json({ message: "Invalid User Details" });
    }

    // 🧩 ADD THIS CHECK HERE — before password match
    if (user.isSuspended) {
      return res.status(403).json({
        message: user.suspendedReason ? `Account suspended: ${user.suspendedReason}` : "Your account has been suspended by an administrator.",
        code: "ACCOUNT_SUSPENDED",
      });
    }

    if (!user.isVerified) {
      return res.status(403).json({
        message: "Please verify your email before logging in.",
      });
    }

    const matches = await user.matchPassword(password);
    if (!matches) {
      return res.status(400).json({ message: "Invalid User Details" });
    }

    // FIX MISSING SELF-FRIEND
    if (!user.friends.includes(user._id)) {
      user.friends.push(user._id);
      await user.save();
    }

    const token = createToken(user._id);
    const refreshToken = generateRefreshToken(user._id);
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: true, // true on Render
      sameSite: "none", // required for Netlify ↔ Render
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      message: "Login Successfully",
      token,
      userId: user._id,
      user: {
        _id: user._id,
        username: user.username,
        name: user.name,
        email: user.email,
        profilePic: user.profilePic,
        about: user.about,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const resendVerification = async (req, res) => {
  const { email } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.isVerified)
      return res.status(400).json({ message: "Email already verified" });

    const verifyToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });
    const verifyLink = `${process.env.BASE_URL}/api/auth/verify-email/${verifyToken}`;

    // Send verification email asynchronously in the background so it doesn't block response
    sendEmail({
      to: email,
      subject: "Verify your Chugli account (Resent)",
      html: `
        <p>Hello ${user.username},</p>
        <p>Here's your new verification link:</p>
        <a href="${verifyLink}" style="background:#1d4ed8;color:white;padding:10px 18px;border-radius:8px;text-decoration:none;">
          Verify My Email
        </a>
      `,
    }).catch((err) => {
      console.error("Resend verification email error:", err);
    });

    res
      .status(200)
      .json({ message: "Verification email resent successfully!" });
  } catch (error) {
    res.status(500).json({ message: "Failed to resend verification email" });
  }
};

const changePassword = async (req, res) => {
  try {
    const userId = req.user._id;
    const { oldPassword, newPassword, confirmPassword } = req.body;

    if (!oldPassword || !newPassword || !confirmPassword) {
      return res
        .status(400)
        .json({ message: "Please provide all required fields" });
    }

    if (newPassword !== confirmPassword) {
      return res
        .status(400)
        .json({ message: "New password and confirm password do not match" });
    }

    // Password strength validation (at least 6 characters, including letters and numbers and special characters)
    const passwordRegex =
      /^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*#?&])[A-Za-z\d@$!%*#?&]{6,}$/;
    if (!passwordRegex.test(newPassword)) {
      return res.status(400).json({
        message:
          "Password must be at least 6 characters long and include letters, numbers, and special characters.",
      });
    }

    const user = await User.findById(userId).select("+password");
    if (!user) return res.status(404).json({ message: "User not found" });

    const isMatch = await user.matchPassword(oldPassword);
    if (!isMatch) {
      return res.status(401).json({ message: "Old password is incorrect" });
    }

    // prevernting reuse of old password
    if (oldPassword === newPassword) {
      return res.status(400).json({
        message: "New password must be different from the old password",
      });
    }
    //set new password (pre-save hook will hash it)
    user.password = newPassword;
    await user.save();

    // optionally issue a new token so client can replace stored token
    const token = createToken(user._id);
    res.status(200).json({ message: "password changed successfully", token });
  } catch (error) {
    // console.log("change password error", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = {
  signup,
  login,
  checkUsername,
  changePassword,
  googleAuth,
  verifyEmail,
  resendVerification,
  refreshTokenHandler,
};
