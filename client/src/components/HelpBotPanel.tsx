import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Bot, Send, Trash2 } from "lucide-react";
import type { User } from "firebase/auth";

type BotMessage = {
  id: string;
  role: "user" | "bot";
  text: string;
  createdAt: number;
};

type Props = { user: User; onBack: () => void };

const storageKey = (uid: string) => `gather-helpbot-v1-${uid}`;
const greeting = "Hi! I'm Gather's built-in help bot. Ask me about signing in, finding people, messages, voice notes, groups, or notifications.";
const suggestions = ["How do I find someone?", "Can I send a voice message?", "How do I reset my password?"];

function welcomeMessage(): BotMessage {
  return { id: "welcome", role: "bot", text: greeting, createdAt: 0 };
}

function isBotMessage(item: unknown): item is BotMessage {
  if (typeof item !== "object" || item === null) return false;
  return "id" in item
    && typeof item.id === "string"
    && "role" in item
    && (item.role === "user" || item.role === "bot")
    && "text" in item
    && typeof item.text === "string"
    && "createdAt" in item
    && typeof item.createdAt === "number";
}

function readHistory(uid: string): BotMessage[] {
  try {
    const stored = localStorage.getItem(storageKey(uid));
    if (!stored) return [welcomeMessage()];
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed) && parsed.every(isBotMessage)) return parsed;
    throw new Error("Saved help chat has an invalid format.");
  } catch (error) {
    console.error("Could not load the saved help chat:", error);
    return [welcomeMessage()];
  }
}

function replyTo(question: string): string {
  const text = question.toLowerCase();
  const topics: Array<{ keywords: string[]; answer: string }> = [
    {
      keywords: ["verify", "verification", "verification email", "confirm email"],
      answer: "Gather requires a verified email before opening chats. Check the inbox for your account, and look in spam or junk if the message isn't there. On the verification screen you can request another email.",
    },
    {
      keywords: ["password", "forgot", "reset"],
      answer: "On the sign-in screen, choose “Forgot password?” and enter your account email. Firebase sends a password-reset link if that address has an account.",
    },
    {
      keywords: ["too many", "rate limit", "locked", "blocked", "auth/too-many"],
      answer: "Firebase temporarily limits repeated sign-in attempts. Wait before trying again, then check your email and password. The app can't remove Firebase's temporary rate limit.",
    },
    {
      keywords: ["find someone", "search", "find user", "search people"],
      answer: "Use “Search people…” in the left sidebar. Search by at least two characters of a person's display name or email, then select them to open a private conversation.",
    },
    {
      keywords: ["voice", "audio", "record", "microphone"],
      answer: "Open a conversation and use the microphone button beside the message box. Allow microphone access, record for up to 2 minutes, then stop to send or cancel. Voice messages need microphone support and work on HTTPS or localhost.",
    },
    {
      keywords: ["image", "photo", "file", "attachment", "document", "pdf"],
      answer: "In a conversation, use the attachment button to share an image, PDF, or Word document. Files are limited to 10 MB and are available only to conversation members.",
    },
    {
      keywords: ["group", "members", "admin"],
      answer: "Choose the + beside Messages or “New group” at the bottom of the sidebar. Enter a group name, search for people to add, and create the group. The creator is its first admin.",
    },
    {
      keywords: ["notification", "notifications", "alert"],
      answer: "Use the bell in the sidebar to turn browser notifications on or off. Your browser must grant permission, and notification preferences are saved in this browser.",
    },
    {
      keywords: ["profile", "picture", "display name", "name"],
      answer: "Open the three-dot menu beside the Gather logo, choose “Edit profile,” update your display name or profile picture URL, and save.",
    },
    {
      keywords: ["sign out", "logout", "log out"],
      answer: "Use “Sign out” at the bottom of the sidebar, or choose it from the three-dot menu beside the Gather logo.",
    },
    {
      keywords: ["private", "privacy", "secure", "security"],
      answer: "Private conversations and files are restricted to their members. This help bot doesn't contact an AI service: its replies are built in, and this bot chat is saved only in this browser on this device.",
    },
  ];
  const match = topics.find((topic) => topic.keywords.some((keyword) => text.includes(keyword)));
  return match?.answer
    ?? "I can help with account verification or password resets, finding people, text and file messages, voice notes, groups, profiles, and notifications. I'm a built-in help bot, so I may not know about topics outside Gather.";
}

function timeLabel(timestamp: number) {
  return timestamp === 0
    ? ""
    : new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function HelpBotPanel({ user, onBack }: Props) {
  const [messages, setMessages] = useState<BotMessage[]>(() => readHistory(user.uid));
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey(user.uid), JSON.stringify(messages));
    } catch (error) {
      console.error("Could not save the help chat in this browser:", error);
    }
  }, [messages, user.uid]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  function sendMessage(suggestedQuestion?: string) {
    const question = (suggestedQuestion ?? draft).trim();
    if (!question) return;
    const now = Date.now();
    setMessages((current) => [
      ...current,
      { id: `${now}-user`, role: "user", text: question, createdAt: now },
      { id: `${now}-bot`, role: "bot", text: replyTo(question), createdAt: now + 1 },
    ]);
    setDraft("");
  }

  function clearChat() {
    setMessages([welcomeMessage()]);
  }

  return <section className="help-bot-view">
    <header className="chat-header">
      <button className="icon-button mobile-back" onClick={onBack} aria-label="Back to messages"><ArrowLeft size={18} /></button>
      <span className="help-bot-avatar"><Bot size={19} /></span>
      <div className="chat-title-button">
        <strong>Gather Help Bot</strong>
        <span>Built-in help · Replies stay on this device</span>
      </div>
      <button className="icon-button" onClick={clearChat} aria-label="Clear help chat" title="Clear chat"><Trash2 size={17} /></button>
    </header>
    <div className="help-bot-messages" aria-live="polite">
      <div className="help-bot-note">A simple guide to the features in Gather. It is not a human or an AI assistant.</div>
      {messages.map((message) => <div className={`help-bot-row ${message.role === "user" ? "help-bot-row-own" : ""}`} key={message.id}>
        {message.role === "bot" && <span className="help-bot-mini-avatar"><Bot size={15} /></span>}
        <div className={`help-bot-bubble ${message.role === "user" ? "help-bot-bubble-own" : ""}`}>
          <p>{message.text}</p>
          {timeLabel(message.createdAt) && <time>{timeLabel(message.createdAt)}</time>}
        </div>
      </div>)}
      {messages.length === 1 && <div className="help-bot-suggestions">
        {suggestions.map((suggestion) => <button key={suggestion} onClick={() => sendMessage(suggestion)}>{suggestion}</button>)}
      </div>}
      <div ref={bottomRef} />
    </div>
    <form className="help-bot-composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}>
      <input
        aria-label="Ask the Gather Help Bot"
        placeholder="Ask how Gather works…"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        maxLength={500}
      />
      <button className="primary-button" type="submit" disabled={!draft.trim()} aria-label="Send question"><Send size={16} /></button>
    </form>
  </section>;
}
