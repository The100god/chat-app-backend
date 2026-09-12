const mongoose = require("mongoose");

const GroupMessageSchema = new mongoose.Schema({
    groupId:{
        type: mongoose.Schema.Types.ObjectId,
        ref:"Group",
        required:true,
    },
    sender:{
        type: mongoose.Schema.Types.ObjectId,
        ref:"User",
        required:true,
    },
    content:{
        type:String,
    },
    media:[
        {
            type:String,
        },
    ],
    seenBy:[
        {
        type: mongoose.Schema.Types.ObjectId,
        ref:"User",
        },
    ],
    isDeleted:{
        type:Boolean,
        default:false,
    },
    deletedFor: [
        {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
        }
    ],
    expiresAt: {
        type: Date,
        default: null,
    },
},
{timestamps:true}
);

GroupMessageSchema.index({ groupId: 1 });
GroupMessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("GroupMessage", GroupMessageSchema);