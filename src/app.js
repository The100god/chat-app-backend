const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const { createServer } = require("http");
const { Server } = require("socket.io");

const cors = require("cors");
const authRoutes = require("./routes/authRoutes");
const friendRoutes = require("./routes/friendRoutes");
const chatRoutes = require("./routes/chatRoutes");
const messageRoutes = require("./routes/messageRoutes");
const userRoutes = require("./routes/userRoute");
const groupRoutes = require("./routes/groupRoutes");
const { initializeSocket } = require("./utils/socketManager");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const mongoSanitize = require("express-mongo-sanitize");
const rateLimit = require("express-rate-limit");

dotenv.config();
const app = express();

app.use(cookieParser());

// Security Middleware
app.use(helmet());
app.use(mongoSanitize());
app.disable("x-powered-by");


// middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true, // REQUIRED
  })
);

// app.use(cors(
//   {
//   origin: process.env.CLIENT_URL,
//   credentials: true,
// }
// ));

// =========================
// Create HTTP Server & Socket.io
// =========================
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Change to your frontend URL,
    // methods: ["GET", "POST"],
    // transports: ["websocket", "polling"], // Ensure WebSocket is allowed
  },
  // for live deployment
  // cors: {
  //   origin: process.env.CLIENT_URL,
  //   methods: ["GET", "POST"],
  //   credentials: true,
  // },
});

//initialize socket.io

initializeSocket(io);

//Attach Socket.io to req in all routes
app.use((req, res, next) => {
  req.io = io;
  next();
})

// Rate limiting configuration
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login/signup attempts from this IP, please try again after 15 minutes." }
});

const path = require("path");
const upload = require("./middleware/upload");
const { uploadMediaToCloudinary, uploadUrlToCloudinary } = require("./utils/cloudinaryHelper");

// Serve static uploaded media files with permissive CORS (legacy fallback)
app.use("/uploads", cors(), express.static(path.join(__dirname, "../uploads")));

// Direct Media Upload Endpoint for Watch & Listen Together (Cloudinary + MongoDB)
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  try {
    const roomId = req.body.roomId || req.query.roomId || "temp";
    const result = await uploadMediaToCloudinary(
      req.file.path,
      req.file.originalname,
      roomId
    );
    res.json(result);
  } catch (err) {
    console.error("Error in /api/upload route:", err);
    res.status(500).json({ error: "Media upload failed", message: err.message });
  }
});

// Remote URL Upload Endpoint for Watch & Listen Together (Cloudinary + MongoDB)
app.post("/api/upload-url", express.json(), async (req, res) => {
  const { url, roomId, title } = req.body;
  if (!url) {
    return res.status(400).json({ error: "No URL provided" });
  }
  try {
    const result = await uploadUrlToCloudinary(url, title || "media", roomId || "temp");
    res.json(result);
  } catch (err) {
    console.error("Error in /api/upload-url route:", err);
    res.status(500).json({ error: "URL upload to Cloudinary failed", message: err.message });
  }
});

//Routes
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/friends", friendRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/message", messageRoutes);
app.use("/api/users", userRoutes);
app.use("/api/groups", groupRoutes);

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "UP",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    dbState: mongoose.connection.readyState === 1 ? "CONNECTED" : "DISCONNECTED"
  });
});

//connect MongoDb

mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDb Connected"))
  .catch((error) => console.log("MongoDb Connection Error: ", error));

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));


module.exports = app;
