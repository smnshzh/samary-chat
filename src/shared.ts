export type ChatMessage = {
  id: string;
  content: string;
  user: string;
  role: "user" | "assistant";
};

export type DirectMessage = {
  type: "direct-add";
  id: string;
  content: string;
  fromUserId: string;
  toUserId: string;
  fromDisplayName: string;
  createdAt: number;
};

export type PresenceMessage = {
  type: "presence";
  userId: string;
  isOnline: boolean;
};

export type RoomInviteMessage = {
  type: "room-invite";
  id: string;
  roomId: string;
  roomName: string;
  fromUserId: string;
  fromDisplayName: string;
  toUserId: string;
  createdAt: number;
};

export type Message =
  | {
      type: "add";
      id: string;
      content: string;
      user: string;
      role: "user" | "assistant";
    }
  | {
      type: "update";
      id: string;
      content: string;
      user: string;
      role: "user" | "assistant";
    }
  | {
      type: "all";
      messages: ChatMessage[];
    }
  | {
      type: "signal";
      fromUserId: string;
      toUserId: string;
      signalType: "offer" | "answer" | "ice-candidate" | "call-end";
      payload: string;
    }
  | DirectMessage
  | {
      type: "direct-all";
      messages: DirectMessage[];
    }
  | PresenceMessage
  | {
      type: "typing";
      fromUserId: string;
      toUserId: string;
      isTyping: boolean;
    }
  | RoomInviteMessage;

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
};

export type ContactUser = {
  id: string;
  username: string;
  displayName: string;
};

export const names = [
  "Alice",
  "Bob",
  "Charlie",
  "David",
  "Eve",
  "Frank",
  "Grace",
  "Heidi",
  "Ivan",
  "Judy",
  "Kevin",
  "Linda",
  "Mallory",
  "Nancy",
  "Oscar",
  "Peggy",
  "Quentin",
  "Randy",
  "Steve",
  "Trent",
  "Ursula",
  "Victor",
  "Walter",
  "Xavier",
  "Yvonne",
  "Zoe",
];
