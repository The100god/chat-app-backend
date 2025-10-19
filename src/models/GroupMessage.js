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
},
{timestamps:true}
);

module.exports = mongoose.model("GroupMessage", GroupMessageSchema)