const mongoose = require("mongoose") 

const messageSchema = new mongoose.Schema({
    chatId :{
        type: mongoose.Schema.Types.ObjectId,
        ref:"Chat"
    },
    sender :{
        type: mongoose.Schema.Types.ObjectId,
        ref:"User"
    },
    receiver: {
      type: mongoose.Schema.Types.ObjectId, 
      ref: "User",
    },
    content:{
        type:String,
        require:false,
        default:"let's Talk!",
    },
    media: {
        type: [String], // array of base64 strings
  default: [],
    },
    isRead:{
        type:Boolean,
        default:false
    },
    expiresAt: {
        type: Date,
        default: null,
    },
    disappearDuration: {
        type: Number,  // Duration in hours (1, 4, 8, 12, 24). null/0 = permanent.
        default: null,
    },

},
{ timestamps: true });

// MongoDB TTL index — automatically deletes documents when expiresAt is reached.
// partialFilterExpression ensures only messages with an actual expiresAt date are
// subject to TTL deletion. Messages with expiresAt: null remain permanent.
messageSchema.index(
    { expiresAt: 1 },
    {
        expireAfterSeconds: 0,
        partialFilterExpression: { expiresAt: { $type: "date" } },
    }
);

module.exports = mongoose.model("Message", messageSchema)