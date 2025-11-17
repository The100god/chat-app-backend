const Message = require("../models/Message");
const User = require("../models/User");

// send Friend request

const sendFriendRequest = async (req, res) => {
  const { senderId, receiverId } = req.body;
  try {
    
    //Check if request already sent
    const receiver = await User.findById(receiverId);
    const sender = await User.findById(senderId);
    if (!receiver || !sender) {
      return res.status(404).json({ message: "User not found." });
    }

    if (receiver.friendRequests.includes(senderId)) {
      return res.status(400).json({ message: "Friend request already sent." });
    }

    if (
      receiver.friends.includes(senderId) ||
      sender.friends.includes(receiverId)
    ) {
      return res.status(400).json({ message: "Already friends." });
    }


    //Add senderId to receiver's FriendRequests
    receiver.friendRequests.push(senderId);
    await receiver.save();
    res.status(200).json({ message: "Friend request sent successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get pending friend requests
const getFriendRequests = async (req, res) => {
  const { userId } = req.params;

  try {
    
    const user = await User.findById(userId).populate(
      "friendRequests",
      "username email"
    );
    res.status(200).json(user.friendRequests);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Accept/Reject Friends request use when we ahve REST api

const respondToFriendRequest = async (req, res) => {
  const { userId, senderId, action } = req.body;

  try {
    const user = await User.findById(userId);
    if (!user.friendRequests.includes(senderId)) {
      return res.status(400).json({ message: "No friend request found." });
    }

    // Remove senderId from FriendRequests
    user.friendRequests = user.friendRequests.filter(
      (id) => id.toString() !== senderId
    );

    if (action === "accepted") {
      //add to friends list if accepted
      user.friends.push(senderId);
      const sender = await User.findById(senderId);
      sender.friends.push(userId);
      await sender.save();
      res.status(200).json({ message: "Friend request accepted." });
    } else {
      res.status(200).json({ message: "Friend request rejected." });
    }
    await user.save();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// use when we have socket.io

const handleFriendRequestSocket = async ({ senderId, receiverId, status,io, users }) => {
  const receiver = await User.findById(receiverId);
  if (!receiver) throw new Error("Receiver not found");

  // if (!receiver.friends.includes(senderId)) {
  //   throw new Error("No friend request found");
  // }
  if (!receiver.friendRequests.includes(senderId)) {
    throw new Error("No friend request found");
  }

  // Remove senderId from friendRequests
  receiver.friendRequests = receiver.friendRequests.filter(
    (id) => id.toString() !== senderId
  );

  if (status === "accepted") {
    receiver.friends.push(senderId);

    const sender = await User.findById(senderId);
    if (!sender) throw new Error("Sender not found");

    sender.friends.push(receiverId);
    await sender.save();
  }

  await receiver.save();
  // Re-fetch updated friends list for both users
  const getFriendDetails = async (userId) => {
    const user = await User.findById(userId).populate(
      "friends",
      "username profilePic"
    );
    const friendDetails = await Promise.all(
      user.friends.map(async (friend) => {
        const unreadMessagesCount = await Message.countDocuments({
          sender: friend._id,
          receiver: userId,
          isRead: false,
        });
        return {
          friendId: friend._id,
          username: friend.username,
          profilePic: friend.profilePic,
          unreadMessagesCount,
        };
      })
    );
    console.log("unreadMessagesCount1", unreadMessagesCount)
    // console.log("friendDetails", friendDetails)
    return friendDetails;
  };
  const receiverFriendsList = await getFriendDetails(receiverId);
  const senderFriendsList = status === "accepted" ? await getFriendDetails(senderId) : [];

  // Emit to receiver (update friend list)
  const receiverSocket = users.get(receiverId);
  if (receiverSocket) {
    io.to(receiverSocket).emit("friendsUpdated", receiverFriendsList);
  }

  // Emit to sender (update friend list)
  const senderSocket = users.get(senderId);
  if (senderSocket) {
    io.to(senderSocket).emit("friendsUpdated", senderFriendsList);
  }
};



// // Get Friend List
// const getFriends = async (req, res) => {
//   const { userId } = req.body;

//   try {
//     const user = await User.findById(userId).populate(
//       "friends",
//       "username email"
//     );
//     res.status(200).json(user.friends);
//   } catch (error) {
//     res.status(500).json({ error: error.message });
//   }
// };

// Get Friend List with Unread Message Count
const getFriends = async (req, res) => {
  const { userId } = req.params; // Get userId from URL params

  try {
    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    // Find user and populate friends
    const user = await User.findById(userId).populate(
      "friends",
      "username profilePic"
    );

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!user.friends || user.friends.length === 0) {
      return res.status(200).json([]); // Return empty array if no friends
    }

    // Get all friends details with unread message count
    const friendDetails = await Promise.all(
      user.friends.map(async (friend) => {
        try {
          const unreadMessagesCount = await Message.countDocuments({
            sender: friend._id,
            receiver: userId, // Check messages where friend is sender and user is receiver
            isRead: false, // Only count unread messages
          });
// console.log("unreadMessagesCount", unreadMessagesCount)
          return {
            friendId: friend._id,
            username: friend.username,
            profilePic: friend.profilePic,
            unreadMessagesCount,
          };
        } catch (messageError) {
          console.error("Error fetching unread messages:", messageError);
          return {
            friendId: friend._id,
            username: friend.username,
            profilePic: friend.profilePic,
            unreadMessagesCount: 0, // If error, return 0 unread messages
          };
        }
      })
    );

    res.status(200).json(friendDetails || []);
  } catch (error) {
    console.error("Error in getFriends:", error);
    res.status(500).json({ error: error.message });
  }
};

// Remove a Friend

const removeFriend = async (req, res) => {
  const { userId, friendId } = req.body;

  try {
    const user = await User.findById(userId);
    const friend = await User.findById(friendId);

    if (!user.friends.includes(friendId)) {
      return res
        .status(400)
        .json({ message: "User is not in your friends list." });
    }

    //remove friend from both users
    user.friends = user.friends.filter((id) => id.toString() !== friendId);
    friend.friends = friend.friends.filter((id) => id.toString() !== userId);

    await user.save();
    await friend.save();
    res.status(200).json({ message: "Friend removed successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  sendFriendRequest,
  respondToFriendRequest,
  getFriends,
  removeFriend,
  getFriendRequests,
  handleFriendRequestSocket,
};
