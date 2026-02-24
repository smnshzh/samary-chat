import {
  type Connection,
  Server,
  type WSMessage,
  routePartykitRequest,
} from "partyserver";

import type {
  AuthUser,
  ChatMessage,
  ContactUser,
  DirectMessage,
  Message,
  UserRoom,
} from "../shared";

type UserRecord = {
  id: string;
  username: string;
  passwordHash: string;
  displayName: string;
  bio: string;
};

type StoredDirectMessage = {
  id: string;
  content: string;
  fromUserId: string;
  toUserId: string;
  fromDisplayName: string;
  createdAt: number;
};

type StoredUserRoom = {
  roomId: string;
  roomName: string;
  role: "creator" | "member";
  joinedAt: number;
};

const SESSION_COOKIE = "chat_session";
const AUTH_OBJECT_ID = "auth";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function getCookieValue(cookieHeader: string | null, cookieName: string) {
  if (!cookieHeader) {
    return null;
  }

  const entries = cookieHeader.split(";").map((entry) => entry.trim());
  for (const entry of entries) {
    if (entry.startsWith(`${cookieName}=`)) {
      return entry.slice(cookieName.length + 1);
    }
  }

  return null;
}

async function sha256(value: string) {
  const input = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64Url(input: string) {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(input: string) {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = base64.length % 4;
  const padded = padding === 0 ? base64 : `${base64}${"=".repeat(4 - padding)}`;
  return atob(padded);
}

async function signPayload(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );

  const signatureText = String.fromCharCode(...new Uint8Array(signature));
  return toBase64Url(signatureText);
}

async function createSessionToken(username: string, secret: string) {
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 7;
  const payload = JSON.stringify({ username, expiresAt });
  const encodedPayload = toBase64Url(payload);
  const signature = await signPayload(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

async function verifySessionToken(token: string, secret: string) {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = await signPayload(encodedPayload, secret);
  if (expectedSignature !== signature) {
    return null;
  }

  const payload = JSON.parse(fromBase64Url(encodedPayload)) as {
    username: string;
    expiresAt: number;
  };

  if (payload.expiresAt < Date.now()) {
    return null;
  }

  return payload;
}

function setSessionCookie(token: string) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export class Auth {
  state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;

    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        bio TEXT NOT NULL DEFAULT ''
      )`,
    );

    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS contacts (
        owner_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        PRIMARY KEY (owner_id, contact_id)
      )`,
    );

    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS direct_messages (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        from_user_id TEXT NOT NULL,
        to_user_id TEXT NOT NULL,
        from_display_name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );

    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS user_rooms (
        user_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        room_name TEXT NOT NULL,
        role TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, room_id)
      )`,
    );

    this.ensureUsersSchema();
  }

  ensureUsersSchema() {
    const columns = this.state.storage.sql
      .exec("PRAGMA table_info(users)")
      .toArray() as Array<{ name: string }>;

    const hasDisplayName = columns.some((column) => column.name === "display_name");
    if (!hasDisplayName) {
      this.state.storage.sql.exec(
        `ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''`,
      );
      this.state.storage.sql.exec(
        `UPDATE users SET display_name = username WHERE display_name = ''`,
      );
    }

    const hasBio = columns.some((column) => column.name === "bio");
    if (!hasBio) {
      this.state.storage.sql.exec(`ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''`);
    }
  }

  toAuthUser(user: UserRecord): AuthUser {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      bio: user.bio,
    };
  }

  getUserByUsername(username: string) {
    const result = this.state.storage.sql
      .exec(
        `SELECT
          id,
          username,
          password_hash as passwordHash,
          display_name as displayName,
          bio
        FROM users
        WHERE username = ?`,
        username,
      )
      .toArray() as UserRecord[];

    return result[0] ?? null;
  }

  getUserById(id: string) {
    const result = this.state.storage.sql
      .exec(
        `SELECT
          id,
          username,
          password_hash as passwordHash,
          display_name as displayName,
          bio
        FROM users
        WHERE id = ?`,
        id,
      )
      .toArray() as UserRecord[];

    return result[0] ?? null;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/register") {
      const body = (await request.json()) as {
        username?: string;
        password?: string;
      };
      const username = body.username?.trim();
      const password = body.password?.trim();

      if (!username || !password || password.length < 6) {
        return json(
          { error: "نام کاربری و رمز عبور معتبر لازم است (حداقل ۶ کاراکتر)." },
          400,
        );
      }

      const existing = this.getUserByUsername(username);
      if (existing) {
        return json({ error: "این نام کاربری قبلاً ثبت شده است." }, 409);
      }

      const passwordHash = await sha256(password);
      const id = crypto.randomUUID();
      const displayName = username;
      this.state.storage.sql.exec(
        `INSERT INTO users (id, username, password_hash, display_name, bio) VALUES (?, ?, ?, ?, '')`,
        id,
        username,
        passwordHash,
        displayName,
      );

      return json({ user: { id, username, displayName, bio: "" } satisfies AuthUser });
    }

    if (request.method === "POST" && url.pathname === "/login") {
      const body = (await request.json()) as {
        username?: string;
        password?: string;
      };
      const username = body.username?.trim();
      const password = body.password?.trim();

      if (!username || !password) {
        return json({ error: "نام کاربری و رمز عبور اجباری هستند." }, 400);
      }

      const user = this.getUserByUsername(username);

      if (!user) {
        return json({ error: "کاربر پیدا نشد." }, 404);
      }

      const passwordHash = await sha256(password);
      if (passwordHash !== user.passwordHash) {
        return json({ error: "رمز عبور اشتباه است." }, 401);
      }

      return json({ user: this.toAuthUser(user) });
    }

    if (request.method === "GET" && url.pathname === "/me") {
      const username = url.searchParams.get("username")?.trim();
      if (!username) {
        return json({ error: "نام کاربری لازم است." }, 400);
      }

      const user = this.getUserByUsername(username);
      if (!user) {
        return json({ error: "کاربر یافت نشد." }, 404);
      }

      return json({ user: this.toAuthUser(user) });
    }

    if (request.method === "POST" && url.pathname === "/profile") {
      const body = (await request.json()) as {
        username?: string;
        displayName?: string;
        bio?: string;
      };
      const username = body.username?.trim();
      const displayName = body.displayName?.trim();
      const bio = body.bio?.trim() ?? "";

      if (!username || !displayName) {
        return json({ error: "نام کاربری و نام نمایشی لازم است." }, 400);
      }

      const user = this.getUserByUsername(username);
      if (!user) {
        return json({ error: "کاربر یافت نشد." }, 404);
      }

      this.state.storage.sql.exec(
        `UPDATE users SET display_name = ?, bio = ? WHERE username = ?`,
        displayName,
        bio,
        username,
      );

      return json({
        user: {
          id: user.id,
          username: user.username,
          displayName,
          bio,
        } satisfies AuthUser,
      });
    }

    if (request.method === "POST" && url.pathname === "/contacts/add") {
      const body = (await request.json()) as {
        username?: string;
        userId?: string;
      };
      const username = body.username?.trim();
      const userId = body.userId?.trim();

      if (!username || !userId) {
        return json({ error: "نام کاربری و آیدی کاربر لازم است." }, 400);
      }

      const owner = this.getUserByUsername(username);
      if (!owner) {
        return json({ error: "کاربر جاری پیدا نشد." }, 404);
      }

      if (owner.id === userId) {
        return json({ error: "نمی‌توانید خودتان را اضافه کنید." }, 400);
      }

      const target = this.getUserById(userId);
      if (!target) {
        return json({ error: "کاربری با این آیدی وجود ندارد." }, 404);
      }

      this.state.storage.sql.exec(
        `INSERT INTO contacts (owner_id, contact_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
        owner.id,
        target.id,
      );

      return json({
        contact: {
          id: target.id,
          username: target.username,
          displayName: target.displayName,
        } satisfies ContactUser,
      });
    }

    if (request.method === "GET" && url.pathname === "/contacts") {
      const username = url.searchParams.get("username")?.trim();
      if (!username) {
        return json({ error: "نام کاربری لازم است." }, 400);
      }

      const owner = this.getUserByUsername(username);
      if (!owner) {
        return json({ error: "کاربر جاری پیدا نشد." }, 404);
      }

      const contacts = this.state.storage.sql
        .exec(
          `SELECT u.id, u.username, u.display_name as displayName
           FROM contacts c
           JOIN users u ON u.id = c.contact_id
           WHERE c.owner_id = ?
           ORDER BY u.display_name ASC`,
          owner.id,
        )
        .toArray() as ContactUser[];

      return json({ contacts });
    }

    if (request.method === "GET" && url.pathname === "/direct") {
      const username = url.searchParams.get("username")?.trim();
      if (!username) {
        return json({ error: "نام کاربری لازم است." }, 400);
      }

      const owner = this.getUserByUsername(username);
      if (!owner) {
        return json({ error: "کاربر جاری پیدا نشد." }, 404);
      }

      const messages = this.state.storage.sql
        .exec(
          `SELECT
            id,
            content,
            from_user_id as fromUserId,
            to_user_id as toUserId,
            from_display_name as fromDisplayName,
            created_at as createdAt
           FROM direct_messages
           WHERE from_user_id = ? OR to_user_id = ?
           ORDER BY created_at ASC`,
          owner.id,
          owner.id,
        )
        .toArray() as StoredDirectMessage[];

      return json({ messages });
    }

    if (request.method === "POST" && url.pathname === "/direct/send") {
      const body = (await request.json()) as {
        username?: string;
        toUserId?: string;
        content?: string;
      };
      const username = body.username?.trim();
      const toUserId = body.toUserId?.trim();
      const content = body.content?.trim();

      if (!username || !toUserId || !content) {
        return json({ error: "فرستنده، گیرنده و متن پیام الزامی است." }, 400);
      }

      const sender = this.getUserByUsername(username);
      if (!sender) {
        return json({ error: "کاربر جاری پیدا نشد." }, 404);
      }

      const receiver = this.getUserById(toUserId);
      if (!receiver) {
        return json({ error: "گیرنده پیدا نشد." }, 404);
      }

      const message = {
        id: crypto.randomUUID(),
        content,
        fromUserId: sender.id,
        toUserId: receiver.id,
        fromDisplayName: sender.displayName,
        createdAt: Date.now(),
      } satisfies StoredDirectMessage;

      this.state.storage.sql.exec(
        `INSERT INTO direct_messages (id, content, from_user_id, to_user_id, from_display_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        message.id,
        message.content,
        message.fromUserId,
        message.toUserId,
        message.fromDisplayName,
        message.createdAt,
      );

      return json({ message });
    }

    if (request.method === "POST" && url.pathname === "/rooms/join") {
      const body = (await request.json()) as {
        username?: string;
        roomId?: string;
        roomName?: string;
        role?: "creator" | "member";
      };
      const username = body.username?.trim();
      const roomId = body.roomId?.trim();
      const roomName = body.roomName?.trim() || roomId;
      const role = body.role === "creator" ? "creator" : "member";

      if (!username || !roomId) {
        return json({ error: "نام کاربری و شناسه اتاق الزامی است." }, 400);
      }

      const user = this.getUserByUsername(username);
      if (!user) {
        return json({ error: "کاربر جاری پیدا نشد." }, 404);
      }

      const joinedAt = Date.now();
      this.state.storage.sql.exec(
        `INSERT INTO user_rooms (user_id, room_id, room_name, role, joined_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, room_id) DO UPDATE SET
           room_name = excluded.room_name,
           role = CASE
             WHEN user_rooms.role = 'creator' OR excluded.role = 'creator' THEN 'creator'
             ELSE 'member'
           END`,
        user.id,
        roomId,
        roomName,
        role,
        joinedAt,
      );

      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/rooms") {
      const username = url.searchParams.get("username")?.trim();
      if (!username) {
        return json({ error: "نام کاربری لازم است." }, 400);
      }

      const user = this.getUserByUsername(username);
      if (!user) {
        return json({ error: "کاربر جاری پیدا نشد." }, 404);
      }

      const rooms = this.state.storage.sql
        .exec(
          `SELECT
            room_id as roomId,
            room_name as roomName,
            role,
            joined_at as joinedAt
           FROM user_rooms
           WHERE user_id = ?
           ORDER BY joined_at DESC`,
          user.id,
        )
        .toArray() as StoredUserRoom[];

      return json({ rooms: rooms as UserRoom[] });
    }

    return new Response("Not found", { status: 404 });
  }
}

export class Chat extends Server<Env> {
  static options = { hibernate: true };

  messages = [] as ChatMessage[];
  directMessages = [] as DirectMessage[];
  onlineUsers = new Set<string>();
  connectionUsers = new Map<string, string>();

  onStart() {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, user TEXT, role TEXT, content TEXT)`,
    );

    this.messages = this.ctx.storage.sql
      .exec(`SELECT * FROM messages`)
      .toArray() as ChatMessage[];

    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS direct_messages (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        from_user_id TEXT NOT NULL,
        to_user_id TEXT NOT NULL,
        from_display_name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );

    this.directMessages = this.ctx.storage.sql
      .exec(
        `SELECT
          id,
          content,
          from_user_id as fromUserId,
          to_user_id as toUserId,
          from_display_name as fromDisplayName,
          created_at as createdAt
         FROM direct_messages
         ORDER BY created_at ASC`,
      )
      .toArray() as DirectMessage[];
  }

  onConnect(connection: Connection) {
    connection.send(
      JSON.stringify({
        type: "all",
        messages: this.messages,
      } satisfies Message),
    );

    connection.send(
      JSON.stringify({
        type: "direct-all",
        messages: this.directMessages,
      } satisfies Message),
    );

    this.onlineUsers.forEach((userId) => {
      connection.send(
        JSON.stringify({
          type: "presence",
          userId,
          isOnline: true,
        } satisfies Message),
      );
    });
  }

  onClose(connection: Connection) {
    const userId = this.connectionUsers.get(connection.id);
    if (!userId) {
      return;
    }

    this.connectionUsers.delete(connection.id);
    const stillOnline = [...this.connectionUsers.values()].some((id) => id === userId);
    if (!stillOnline) {
      this.onlineUsers.delete(userId);
      this.broadcast(
        JSON.stringify({
          type: "presence",
          userId,
          isOnline: false,
        } satisfies Message),
      );
    }
  }

  saveMessage(message: ChatMessage) {
    const existingMessage = this.messages.find((m) => m.id === message.id);
    if (existingMessage) {
      this.messages = this.messages.map((m) => (m.id === message.id ? message : m));
    } else {
      this.messages.push(message);
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO messages (id, user, role, content) VALUES ('${
        message.id
      }', '${message.user}', '${message.role}', ${JSON.stringify(
        message.content,
      )}) ON CONFLICT (id) DO UPDATE SET content = ${JSON.stringify(
        message.content,
      )}`,
    );
  }

  saveDirectMessage(message: DirectMessage) {
    this.directMessages.push(message);
    this.ctx.storage.sql.exec(
      `INSERT INTO direct_messages (id, content, from_user_id, to_user_id, from_display_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      message.id,
      message.content,
      message.fromUserId,
      message.toUserId,
      message.fromDisplayName,
      message.createdAt,
    );
  }

  updatePresence(connection: Connection, userId: string, isOnline: boolean) {
    if (!isOnline) {
      return;
    }

    this.connectionUsers.set(connection.id, userId);
    if (!this.onlineUsers.has(userId)) {
      this.onlineUsers.add(userId);
      this.broadcast(
        JSON.stringify({
          type: "presence",
          userId,
          isOnline: true,
        } satisfies Message),
      );
    }
  }

  onMessage(connection: Connection, message: WSMessage) {
    this.broadcast(message);

    const parsed = JSON.parse(message as string) as Message;
    if (parsed.type === "add" || parsed.type === "update") {
      this.saveMessage(parsed);
      return;
    }

    if (parsed.type === "direct-add") {
      this.saveDirectMessage(parsed);
      return;
    }

    if (parsed.type === "presence") {
      this.updatePresence(connection, parsed.userId, parsed.isOnline);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const authStub = env.Auth.get(env.Auth.idFromName(AUTH_OBJECT_ID));

    if (request.method === "POST" && url.pathname === "/api/auth/register") {
      const response = await authStub.fetch("https://auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await request.text(),
      });

      if (!response.ok) {
        return response;
      }

      const data = (await response.json()) as { user: AuthUser };
      const token = await createSessionToken(data.user.username, env.AUTH_SECRET);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": setSessionCookie(token),
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      const response = await authStub.fetch("https://auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await request.text(),
      });

      if (!response.ok) {
        return response;
      }

      const data = (await response.json()) as { user: AuthUser };
      const token = await createSessionToken(data.user.username, env.AUTH_SECRET);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": setSessionCookie(token),
        },
      });
    }

    const cookie = getCookieValue(request.headers.get("cookie"), SESSION_COOKIE);
    const payload = cookie
      ? await verifySessionToken(cookie, env.AUTH_SECRET)
      : null;

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": clearSessionCookie(),
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/auth/me") {
      if (!payload) {
        return json({ authenticated: false });
      }

      const response = await authStub.fetch(
        `https://auth/me?username=${encodeURIComponent(payload.username)}`,
      );

      if (!response.ok) {
        return json({ authenticated: false });
      }

      const data = (await response.json()) as { user: AuthUser };
      return json({ authenticated: true, user: data.user });
    }

    if (request.method === "POST" && url.pathname === "/api/users/profile") {
      if (!payload) {
        return json({ error: "Unauthorized" }, 401);
      }

      const body = (await request.json()) as { displayName?: string; bio?: string };
      return authStub.fetch("https://auth/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: payload.username,
          displayName: body.displayName,
          bio: body.bio,
        }),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/users/contacts/add") {
      if (!payload) {
        return json({ error: "Unauthorized" }, 401);
      }

      const body = (await request.json()) as { userId?: string };
      return authStub.fetch("https://auth/contacts/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: payload.username,
          userId: body.userId,
        }),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/users/contacts") {
      if (!payload) {
        return json({ error: "Unauthorized" }, 401);
      }

      return authStub.fetch(
        `https://auth/contacts?username=${encodeURIComponent(payload.username)}`,
      );
    }

    if (request.method === "GET" && url.pathname === "/api/direct") {
      if (!payload) {
        return json({ error: "Unauthorized" }, 401);
      }

      return authStub.fetch(
        `https://auth/direct?username=${encodeURIComponent(payload.username)}`,
      );
    }

    if (request.method === "POST" && url.pathname === "/api/direct/send") {
      if (!payload) {
        return json({ error: "Unauthorized" }, 401);
      }

      const body = (await request.json()) as { toUserId?: string; content?: string };
      return authStub.fetch("https://auth/direct/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: payload.username,
          toUserId: body.toUserId,
          content: body.content,
        }),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/rooms/join") {
      if (!payload) {
        return json({ error: "Unauthorized" }, 401);
      }

      const body = (await request.json()) as {
        roomId?: string;
        roomName?: string;
        role?: "creator" | "member";
      };

      return authStub.fetch("https://auth/rooms/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: payload.username,
          roomId: body.roomId,
          roomName: body.roomName,
          role: body.role,
        }),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/rooms") {
      if (!payload) {
        return json({ error: "Unauthorized" }, 401);
      }

      return authStub.fetch(
        `https://auth/rooms?username=${encodeURIComponent(payload.username)}`,
      );
    }

    return (
      (await routePartykitRequest(request, { ...env })) ||
      env.ASSETS.fetch(request)
    );
  },
} satisfies ExportedHandler<Env>;
