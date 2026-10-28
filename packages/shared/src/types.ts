
/** Longest chat question, in characters. */
export const QUEEN_CHAT_QUESTION_MAX = 4000;
/** Earlier turns of a chat sent with one question at most (oldest first). */
export const QUEEN_CHAT_HISTORY_MAX = 12;
/** Longest `QueenChatTurn.content`, in characters. */
export const QUEEN_CHAT_TURN_MAX = 6000;
/** All of a chat's earlier turns together, in characters. */
export const QUEEN_CHAT_HISTORY_CHARS_MAX = 24_000;
/** Attachments one question carries at most. */
export const QUEEN_CHAT_FILES_MAX = 4;

/** One earlier turn of a chat, as the asker's client keeps it. */
export interface QueenChatTurn {
  role: "user" | "assistant";
  /** At most QUEEN_CHAT_TURN_MAX characters; an assistant turn is her earlier answer (markdown) */
  content: string;
}
export const QUEEN_FOLLOWUPS_MAX = 3;
