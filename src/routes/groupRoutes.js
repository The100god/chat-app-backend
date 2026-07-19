const express = require("express")
const router = express.Router()
const {
  CreateGroup,
  GetAllGroups,
  GetGroupMessages,
  SendGroupMessageToDb,
  GetGroupDetails,
  UpdateGroupInfo,
  AddGroupMembers,
  RemoveGroupMember,
  PromoteToAdmin,
  DemoteFromAdmin,
  LeaveGroup,
  DeleteGroup,
} = require("../controllers/groupController")

router.post("/create-group", CreateGroup)
router.post("/send-group-message", SendGroupMessageToDb)
router.get("/:userId", GetAllGroups)
router.get("/group-message/:groupId", GetGroupMessages)
router.get("/details/:groupId", GetGroupDetails)
router.put("/update-info/:groupId", UpdateGroupInfo)
router.put("/add-members/:groupId", AddGroupMembers)
router.put("/remove-member/:groupId", RemoveGroupMember)
router.put("/promote/:groupId", PromoteToAdmin)
router.put("/demote/:groupId", DemoteFromAdmin)
router.put("/leave/:groupId", LeaveGroup)
router.delete("/delete-group/:groupId", DeleteGroup)

module.exports = router;