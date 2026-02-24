import { createRoot } from "react-dom/client";
import { usePartySocket } from "partysocket/react";
import React, { useEffect, useMemo, useState } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
  useParams,
} from "react-router";
import { nanoid } from "nanoid";

import { type AuthUser, type ChatMessage, type Message } from "../shared";

type AuthResponse = {
  authenticated: boolean;
  user?: AuthUser;
};

function LoginGate({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ username, password }),
      });

      const data = (await response.json()) as { username?: string; error?: string };

      if (!response.ok || !data.username) {
        setError(data.error ?? "ورود ناموفق بود.");
        return;
      }

      onAuthenticated({ username: data.username });
    } catch {
      setError("خطا در ارتباط با سرور.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth container">
      <h4>{mode === "login" ? "ورود" : "ثبت‌نام"}</h4>
      <form onSubmit={submit}>
        <input
          type="text"
          placeholder="نام کاربری"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          minLength={3}
          required
        />
        <input
          type="password"
          placeholder="رمز عبور"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          minLength={6}
          required
        />
        <button type="submit" disabled={loading}>
          {loading ? "..." : mode === "login" ? "ورود" : "ثبت‌نام"}
        </button>
      </form>
      <button
        className="auth-switch"
        type="button"
        onClick={() => setMode(mode === "login" ? "register" : "login")}
      >
        {mode === "login" ? "حساب ندارید؟ ثبت‌نام" : "حساب دارید؟ ورود"}
      </button>
      {error ? <p className="auth-error">{error}</p> : null}
    </div>
  );
}

function ChatApp({ user }: { user: AuthUser }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const { room } = useParams();
  const navigate = useNavigate();

  const socket = usePartySocket({
    party: "chat",
    room,
    onMessage: (evt) => {
      const message = JSON.parse(evt.data as string) as Message;
      if (message.type === "add") {
        const foundIndex = messages.findIndex((m) => m.id === message.id);
        if (foundIndex === -1) {
          setMessages((allMessages) => [...allMessages, { ...message }]);
        } else {
          setMessages((allMessages) => {
            return allMessages
              .slice(0, foundIndex)
              .concat({ ...message })
              .concat(allMessages.slice(foundIndex + 1));
          });
        }
      } else if (message.type === "update") {
        setMessages((allMessages) =>
          allMessages.map((item) => (item.id === message.id ? { ...message } : item)),
        );
      } else {
        setMessages(message.messages);
      }
    },
  });

  return (
    <div className="chat container">
      <div className="auth-header">
        <span>وارد شده با: {user.username}</span>
        <button
          type="button"
          onClick={async () => {
            await fetch("/api/auth/logout", {
              method: "POST",
              credentials: "include",
            });
            navigate(0);
          }}
        >
          خروج
        </button>
      </div>
      {messages.map((message) => (
        <div key={message.id} className="row message">
          <div className="two columns user">{message.user}</div>
          <div className="ten columns">{message.content}</div>
        </div>
      ))}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const content = e.currentTarget.elements.namedItem("content") as HTMLInputElement;
          if (!content.value.trim()) {
            return;
          }

          const chatMessage: ChatMessage = {
            id: nanoid(8),
            content: content.value,
            user: user.username,
            role: "user",
          };
          setMessages((allMessages) => [...allMessages, chatMessage]);

          socket.send(
            JSON.stringify({
              type: "add",
              ...chatMessage,
            } satisfies Message),
          );

          content.value = "";
        }}
      >
        <input
          type="text"
          name="content"
          className="ten columns my-input-text"
          placeholder={`سلام ${user.username}! پیام خود را بنویس...`}
          autoComplete="off"
        />
        <button type="submit" className="send-message two columns">
          Send
        </button>
      </form>
    </div>
  );
}

function App() {
  const [authState, setAuthState] = useState<"loading" | "anonymous" | "authenticated">(
    "loading",
  );
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    const loadAuth = async () => {
      const response = await fetch("/api/auth/me", {
        credentials: "include",
      });
      const data = (await response.json()) as AuthResponse;

      if (data.authenticated && data.user) {
        setUser(data.user);
        setAuthState("authenticated");
      } else {
        setAuthState("anonymous");
      }
    };

    void loadAuth();
  }, []);

  if (authState === "loading") {
    return <div className="auth container">Loading...</div>;
  }

  if (authState === "anonymous") {
    return (
      <LoginGate
        onAuthenticated={(authenticatedUser) => {
          setUser(authenticatedUser);
          setAuthState("authenticated");
        }}
      />
    );
  }

  if (!user) {
    return null;
  }

  return <ChatApp user={user} />;
}

function AppRoutes() {
  const generatedRoom = useMemo(() => nanoid(), []);

  return (
    <Routes>
      <Route path="/" element={<Navigate to={`/${generatedRoom}`} />} />
      <Route path="/:room" element={<App />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <AppRoutes />
  </BrowserRouter>,
);
