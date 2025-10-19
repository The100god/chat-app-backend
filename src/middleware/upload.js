// middleware/upload.js
const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../utils/cloudinary");

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "gappo_chat_media", // Cloudinary folder name
    allowed_formats: ["jpg", "png", "jpeg", "gif", "mp4", "webm"],
    resource_type: "auto", // allows both image & video
  },
});
// const path = require("path");

// const storage = multer.diskStorage({
//   destination: "uploads/",
//   filename: (req, file, cb) => {
//     const uniqueName = `${Date.now()}-${file.originalname}`;
//     cb(null, uniqueName);
//   },
// });

const upload = multer({ storage });

module.exports = upload;
