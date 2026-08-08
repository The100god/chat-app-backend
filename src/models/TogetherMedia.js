const mongoose = require("mongoose");

const togetherMediaSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      index: true,
    },
    publicId: {
      type: String,
      required: true,
    },
    url: {
      type: String,
      required: true,
    },
    resourceType: {
      type: String,
      default: "auto",
    },
    filename: {
      type: String,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("TogetherMedia", togetherMediaSchema);
