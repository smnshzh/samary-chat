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
  type ContactUser,
  type DirectMessage,
  type Message,
} from "../shared";

const APP_LOGO_URL = "https://planning-marketer.storage.c2.liara.space/logo/logo.png";
const DEFAULT_ROOM = "samary-global";

type AuthResponse = {
  authenticated: boolean;
  user?: AuthUser;
};

function AppBrand() {
  return (
    <div className="app-brand">
      <img src={APP_LOGO_URL} alt="Samary Chat" className="app-logo" />
      <div>
        <p className="brand-kicker">Private Chat</p>
        <h4>Samary Chat</h4>
      </div>
    </div>
  );
}

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
    <div className="auth-shell">
      <div className="auth container glass-panel">
        <AppBrand />
        <p className="muted">ارتباط امن و خصوصی با دوستانت در یک محیط مدرن.</p>
        <h5>{mode === "login" ? "ورود" : "ثبت‌نام"}</h5>
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
          <button type="submit" disabled={loading} className="button-primary full-width">
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
    </div>
  );
}

function ChatApp({ user, onUserUpdate }: { user: AuthUser; onUserUpdate: (user: AuthUser) => void }) {
  const [contacts, setContacts] = useState<ContactUser[]>([]);
  const [directMessages, setDirectMessages] = useState<DirectMessage[]>([]);
  const [onlineUsers, setOnlineUsers] = useState<Record<string, boolean>>({});
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
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

      if (message.type === "direct-all") {
        setDirectMessages(message.messages);
        return;
      }

      if (message.type === "direct-add") {
        setDirectMessages((all) => {
          if (all.some((item) => item.id === message.id)) {
            return all;
          }
          return [...all, message];
        });
        return;
      }

      if (message.type === "presence") {
        setOnlineUsers((all) => ({ ...all, [message.userId]: message.isOnline }));
        return;
      }

      if (message.type === "signal" && message.toUserId === user.id) {
        void handleSignal(message);
      }
    },
  });


  useEffect(() => {
    socket.send(
      JSON.stringify({
        type: "presence",
        userId: user.id,
        isOnline: true,
      } satisfies Message),
    );
  }, [socket, user.id]);

  const loadContacts = async () => {
    const response = await fetch("/api/users/contacts", { credentials: "include" });
    const data = (await response.json()) as { contacts?: ContactUser[]; error?: string };
    if (response.ok && data.contacts) {
      setContacts(data.contacts);
      if (!selectedContactId && data.contacts[0]) {
        setSelectedContactId(data.contacts[0].id);
      }
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

  const startVideoCall = async (targetId?: string) => {
    const destination = (targetId ?? callTargetId).trim();
    if (!destination) {
      setStatusMessage("یک مخاطب را برای تماس انتخاب کنید.");
      return;
    }

    setCallTargetId(destination);
    const peer = createPeer();
    const stream = await ensureLocalStream();
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    socket.send(
      JSON.stringify({
        type: "signal",
        fromUserId: user.id,
        toUserId: destination,
        signalType: "offer",
        payload: JSON.stringify(offer),
      } satisfies Message),
    );

    setIncomingCallFrom(null);
  };

  const endCall = () => {
    if (callTargetId) {
      socket.send(
        JSON.stringify({
          type: "signal",
          fromUserId: user.id,
          toUserId: callTargetId,
          signalType: "call-end",
          payload: "",
        } satisfies Message),
      );
    }

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

  const selectedContact = contacts.find((contact) => contact.id === selectedContactId) ?? null;

  const currentChatMessages = directMessages.filter(
    (message) =>
      selectedContact &&
      ((message.fromUserId === user.id && message.toUserId === selectedContact.id) ||
        (message.fromUserId === selectedContact.id && message.toUserId === user.id)),
  );

  return (
    <div className="chat-app">
      <aside className="sidebar glass-panel">
        <AppBrand />
        <div className="user-block">
          <div>وارد شده با: {user.username}</div>
          <div>
            آیدی شما: <code>{user.id}</code>
          </div>
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
            <input
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder="نام نمایشی"
              required
            />
            <input value={profileBio} onChange={(e) => setProfileBio(e.target.value)} placeholder="بیو" />
            <button type="submit">ذخیره پروفایل</button>
          </form>
        </div>

        <div className="panel">
          <h6>افزودن مخاطب</h6>
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
                setStatusMessage("کاربر اضافه شد. حالا می‌توانید چت و تماس بگیرید.");
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
          <ul className="contact-list">
            {contacts.map((contact) => {
              const isSelected = selectedContactId === contact.id;
              const isOnline = Boolean(onlineUsers[contact.id]);
              return (
                <li key={contact.id} className={isSelected ? "active-contact" : ""}>
                  <button
                    type="button"
                    className="contact-item"
                    onClick={() => {
                      setSelectedContactId(contact.id);
                      setCallTargetId(contact.id);
                    }}
                  >
                    <div>
                      <div>{contact.displayName}</div>
                      <small>@{contact.username}</small>
                    </div>
                    <span className={`online-pill ${isOnline ? "online" : "offline"}`}>
                      {isOnline ? "آنلاین" : "آفلاین"}
                    </span>
                  </button>
                  <button type="button" onClick={() => void startVideoCall(contact.id)}>
                    تماس
                  </button>
                </li>
              );
            })}
          </ul>
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
      </aside>

      <main className="chat-main glass-panel">
        <div className="panel">
          <h6>
            {selectedContact
              ? `گفتگو با ${selectedContact.displayName}`
              : "یک مخاطب را برای شروع گفتگو انتخاب کنید"}
          </h6>
          {selectedContact ? (
            <p className="status-line">
              وضعیت: {onlineUsers[selectedContact.id] ? "آنلاین" : "آفلاین"}
            </p>
          ) : null}
        </div>

        <div className="panel">
          <h6>تماس تصویری</h6>
          <div className="call-actions">
            <button type="button" disabled={!selectedContact} onClick={() => void startVideoCall()}>
              شروع تماس با مخاطب انتخابی
            </button>
            <button type="button" onClick={endCall}>
              قطع تماس
            </button>
          </div>
          {incomingCallFrom ? <p>تماس ورودی از: {incomingCallFrom}</p> : null}
          <div className="videos">
            <video ref={localVideoRef} autoPlay muted playsInline />
            <video ref={remoteVideoRef} autoPlay playsInline />
          </div>
          {callActive ? <p>تماس فعال است.</p> : null}
        </div>

        {statusMessage ? <p className="status-line">{statusMessage}</p> : null}

        <section className="messages-shell">
          {currentChatMessages.map((message) => (
            <div
              key={message.id}
              className={`message-bubble ${message.fromUserId === user.id ? "self" : "other"}`}
            >
              <div className="message-user">{message.fromDisplayName}</div>
              <div>{message.content}</div>
            </div>
          ))}
        </section>

        <form
          className="compose-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!selectedContact) {
              setStatusMessage("ابتدا یک مخاطب انتخاب کنید.");
              return;
            }

            const content = e.currentTarget.elements.namedItem("content") as HTMLInputElement;
            if (!content.value.trim()) {
              return;
            }

            const chatMessage: DirectMessage = {
              type: "direct-add",
              id: nanoid(10),
              content: content.value.trim(),
              fromUserId: user.id,
              toUserId: selectedContact.id,
              fromDisplayName: user.displayName,
              createdAt: Date.now(),
            };

            setDirectMessages((allMessages) => [...allMessages, chatMessage]);
            socket.send(JSON.stringify(chatMessage satisfies Message));

            content.value = "";
          }}
        >
          <input
            type="text"
            name="content"
            className="my-input-text"
            placeholder={
              selectedContact
                ? `پیام به ${selectedContact.displayName}`
                : "یک مخاطب را برای ارسال پیام انتخاب کنید"
            }
            autoComplete="off"
            disabled={!selectedContact}
          />
          <button type="submit" className="send-message button-primary" disabled={!selectedContact}>
            ارسال
          </button>
        </form>
      </main>
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
  const generatedRoom = useMemo(() => DEFAULT_ROOM, []);

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
