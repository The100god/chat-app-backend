const fs = require("fs");
const cloudinary = require("./cloudinary");
const TogetherMedia = require("../models/TogetherMedia");

/**
 * Upload a local temporary file to Cloudinary and record it in MongoDB.
 * Removes the temporary disk file after uploading.
 */
async function uploadMediaToCloudinary(filePath, originalFilename, roomId = "temp") {
  try {
    const uploaded = await cloudinary.uploader.upload(filePath, {
      folder: "together_media",
      resource_type: "auto",
    });

    // Remove local temporary file
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (unlinkErr) {
        console.error("Failed to delete temp upload file:", unlinkErr);
      }
    }

    const resourceType = uploaded.resource_type || "video";

    // Save record to DB
    const record = new TogetherMedia({
      roomId: roomId || "temp",
      publicId: uploaded.public_id,
      url: uploaded.secure_url,
      resourceType: resourceType,
      filename: originalFilename || "media",
    });
    await record.save();

    console.log(`☁️ Cloudinary Upload Success: ${uploaded.secure_url} (Room: ${roomId})`);

    return {
      url: uploaded.secure_url,
      public_id: uploaded.public_id,
      filename: originalFilename,
      resource_type: resourceType,
    };
  } catch (error) {
    // Ensure temp file is cleaned up even on failure
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (e) {}
    }
    console.error("Cloudinary upload error:", error);
    throw error;
  }
}

/**
 * Upload a remote media URL directly to Cloudinary and record it in MongoDB.
 */
async function uploadUrlToCloudinary(mediaUrl, originalFilename = "media", roomId = "temp") {
  try {
    const uploaded = await cloudinary.uploader.upload(mediaUrl, {
      folder: "together_media",
      resource_type: "auto",
    });

    const resourceType = uploaded.resource_type || "video";

    const record = new TogetherMedia({
      roomId: roomId || "temp",
      publicId: uploaded.public_id,
      url: uploaded.secure_url,
      resourceType: resourceType,
      filename: originalFilename,
    });
    await record.save();

    console.log(`☁️ Cloudinary Upload URL Success: ${uploaded.secure_url} (Room: ${roomId})`);

    return {
      url: uploaded.secure_url,
      public_id: uploaded.public_id,
      filename: originalFilename,
      resource_type: resourceType,
    };
  } catch (error) {
    console.error("Cloudinary upload URL error:", error);
    throw error;
  }
}

/**
 * Delete all Cloudinary media assets and DB records associated with a room when it closes.
 */
async function cleanupRoomMedia(roomId) {
  if (!roomId) return;
  try {
    const mediaList = await TogetherMedia.find({ roomId });
    if (!mediaList || mediaList.length === 0) return;

    for (const media of mediaList) {
      try {
        // Attempt destroy with primary resourceType
        await cloudinary.uploader.destroy(media.publicId, {
          resource_type: media.resourceType || "video",
          invalidate: true,
        });
      } catch (err) {
        console.warn(`Cloudinary primary destroy failed for ${media.publicId}, trying fallbacks:`, err.message);
        try {
          await cloudinary.uploader.destroy(media.publicId, { resource_type: "image", invalidate: true });
        } catch (e1) {}
        try {
          await cloudinary.uploader.destroy(media.publicId, { resource_type: "raw", invalidate: true });
        } catch (e2) {}
      }
    }

    await TogetherMedia.deleteMany({ roomId });
    console.log(`🗑️ Successfully cleaned up ${mediaList.length} Cloudinary media file(s) & DB entries for room ${roomId}`);
  } catch (error) {
    console.error(`Error cleaning up media for room ${roomId}:`, error);
  }
}

module.exports = {
  uploadMediaToCloudinary,
  uploadUrlToCloudinary,
  cleanupRoomMedia,
};
