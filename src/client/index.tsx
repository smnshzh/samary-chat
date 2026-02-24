import { createRoot } from "react-dom/client";
import { usePartySocket } from "partysocket/react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
  useParams,
} from "react-router";
import { nanoid } from "nanoid";

import {
  type AuthUser,
  type ChatMessage,
  type ContactUser,
  type Message,
} from "../shared";

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

      const data = (await response.json()) as { user?: AuthUser; error?: string };

      if (!response.ok || !data.user) {
        setError(data.error ?? "ورود ناموفق بود.");
        return;
      }

      onAuthenticated(data.user);
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

function ChatApp({ user, onUserUpdate }: { user: AuthUser; onUserUpdate: (user: AuthUser) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [contacts, setContacts] = useState<ContactUser[]>([]);
  const [contactIdInput, setContactIdInput] = useState("");
  const [profileName, setProfileName] = useState(user.displayName);
  const [profileBio, setProfileBio] = useState(user.bio);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [callTargetId, setCallTargetId] = useState("");
  const [callActive, setCallActive] = useState(false);
  const [incomingCallFrom, setIncomingCallFrom] = useState<string | null>(null);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);

  const { room } = useParams();
  const navigate = useNavigate();

  const socket = usePartySocket({
    party: "chat",
    room,
    onMessage: (evt) => {
      const message = JSON.parse(evt.data as string) as Message;
      if (message.type === "add") {
        setMessages((allMessages) => {
          const foundIndex = allMessages.findIndex((m) => m.id === message.id);
          if (foundIndex === -1) {
            return [...allMessages, { ...message }];
          }
          return allMessages.map((m) => (m.id === message.id ? { ...message } : m));
        });
        return;
      }

      if (message.type === "update") {
        setMessages((allMessages) =>
          allMessages.map((item) => (item.id === message.id ? { ...message } : item)),
        );
        return;
      }

      if (message.type === "all") {
        setMessages(message.messages);
        return;
      }

      if (message.type === "signal" && message.toUserId === user.id) {
        void handleSignal(message);
      }
    },
  });

  const loadContacts = async () => {
    const response = await fetch("/api/users/contacts", { credentials: "include" });
    const data = (await response.json()) as { contacts?: ContactUser[]; error?: string };
    if (response.ok && data.contacts) {
      setContacts(data.contacts);
    } else if (data.error) {
      setStatusMessage(data.error);
    }
  };

  useEffect(() => {
    void loadContacts();
  }, []);

  const createPeer = () => {
    const peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    peer.ontrack = (event) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0] ?? null;
      }
    };

    peer.onicecandidate = (event) => {
      if (!event.candidate || !callTargetId) {
        return;
      }

      socket.send(
        JSON.stringify({
          type: "signal",
          fromUserId: user.id,
          toUserId: callTargetId,
          signalType: "ice-candidate",
          payload: JSON.stringify(event.candidate),
        } satisfies Message),
      );
    };

    peerRef.current = peer;
    return peer;
  };

  const ensureLocalStream = async () => {
    if (!localStreamRef.current) {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
    }

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }

    return localStreamRef.current;
  };

  const handleSignal = async (message: Extract<Message, { type: "signal" }>) => {
    if (message.signalType === "call-end") {
      endCall();
      return;
    }

    setCallTargetId(message.fromUserId);

    let peer = peerRef.current;
    if (!peer) {
      peer = createPeer();
      const stream = await ensureLocalStream();
      stream.getTracks().forEach((track) => peer?.addTrack(track, stream));
    }

    if (message.signalType === "offer") {
      setIncomingCallFrom(message.fromUserId);
      await peer.setRemoteDescription(
        new RTCSessionDescription(JSON.parse(message.payload) as RTCSessionDescriptionInit),
      );
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.send(
        JSON.stringify({
          type: "signal",
          fromUserId: user.id,
          toUserId: message.fromUserId,
          signalType: "answer",
          payload: JSON.stringify(answer),
        } satisfies Message),
      );
      setCallActive(true);
      return;
    }

    if (message.signalType === "answer") {
      await peer.setRemoteDescription(
        new RTCSessionDescription(JSON.parse(message.payload) as RTCSessionDescriptionInit),
      );
      setCallActive(true);
      return;
    }

    if (message.signalType === "ice-candidate") {
      await peer.addIceCandidate(
        new RTCIceCandidate(JSON.parse(message.payload) as RTCIceCandidateInit),
      );
    }
  };

  const startVideoCall = async () => {
    if (!callTargetId.trim()) {
      setStatusMessage("برای تماس تصویری، آیدی مقصد را وارد کنید.");
      return;
    }

    const peer = createPeer();
    const stream = await ensureLocalStream();
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    socket.send(
      JSON.stringify({
        type: "signal",
        fromUserId: user.id,
        toUserId: callTargetId.trim(),
        signalType: "offer",
        payload: JSON.stringify(offer),
      } satisfies Message),
    );

    setIncomingCallFrom(null);
  };

  const endCall = () => {
    peerRef.current?.close();
    peerRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    setCallActive(false);
  };

  return (
    <div className="chat container">
      <div className="auth-header">
        <div>
          <div>وارد شده با: {user.username}</div>
          <div>آیدی شما: <code>{user.id}</code></div>
        </div>
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

      <div className="panel">
        <h6>پروفایل</h6>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const response = await fetch("/api/users/profile", {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ displayName: profileName, bio: profileBio }),
            });
            const data = (await response.json()) as { user?: AuthUser; error?: string };
            if (response.ok && data.user) {
              onUserUpdate(data.user);
              setStatusMessage("پروفایل با موفقیت ذخیره شد.");
            } else {
              setStatusMessage(data.error ?? "خطا در ذخیره پروفایل.");
            }
          }}
        >
          <input value={profileName} onChange={(e) => setProfileName(e.target.value)} placeholder="نام نمایشی" required />
          <input value={profileBio} onChange={(e) => setProfileBio(e.target.value)} placeholder="بیو" />
          <button type="submit">ذخیره پروفایل</button>
        </form>
      </div>

      <div className="panel">
        <h6>افزودن کاربر با آیدی</h6>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const response = await fetch("/api/users/contacts/add", {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ userId: contactIdInput.trim() }),
            });
            const data = (await response.json()) as { error?: string };
            if (response.ok) {
              setContactIdInput("");
              setStatusMessage("کاربر اضافه شد.");
              await loadContacts();
            } else {
              setStatusMessage(data.error ?? "افزودن کاربر ناموفق بود.");
            }
          }}
        >
          <input
            type="text"
            value={contactIdInput}
            onChange={(event) => setContactIdInput(event.target.value)}
            placeholder="User ID"
            required
          />
          <button type="submit">Add</button>
        </form>
        <ul>
          {contacts.map((contact) => (
            <li key={contact.id}>
              {contact.displayName} ({contact.username}) — <code>{contact.id}</code>
            </li>
          ))}
        </ul>
      </div>

      <div className="panel">
        <h6>مکالمه تصویری</h6>
        <input
          value={callTargetId}
          onChange={(event) => setCallTargetId(event.target.value)}
          placeholder="آیدی کاربر مقصد"
        />
        <div className="call-actions">
          <button type="button" onClick={() => void startVideoCall()}>شروع تماس</button>
          <button type="button" onClick={endCall}>قطع تماس</button>
        </div>
        {incomingCallFrom ? <p>تماس ورودی از: {incomingCallFrom}</p> : null}
        <div className="videos">
          <video ref={localVideoRef} autoPlay muted playsInline />
          <video ref={remoteVideoRef} autoPlay playsInline />
        </div>
        {callActive ? <p>تماس فعال است.</p> : null}
      </div>

      {statusMessage ? <p>{statusMessage}</p> : null}

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
            user: user.displayName,
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
          placeholder={`سلام ${user.displayName}! پیام خود را بنویس...`}
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

  return <ChatApp user={user} onUserUpdate={setUser} />;
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
