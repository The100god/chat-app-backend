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
    }

},
{ timestamps: true });

module.exports = mongoose.model("Message", messageSchema)