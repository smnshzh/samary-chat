import {
  type Connection,
  Server,
  type WSMessage,
  routePartykitRequest,
} from "partyserver";

import type { AuthUser, ChatMessage, ContactUser, Message } from "../shared";

type UserRecord = {
  id: string;
  username: string;
  passwordHash: string;
  displayName: string;
  bio: string;
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
    return this.state.storage.sql
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
      .one() as UserRecord | null;
  }

  getUserById(id: string) {
    return this.state.storage.sql
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
      .one() as UserRecord | null;
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

    return new Response("Not found", { status: 404 });
  }
}

export class Chat extends Server<Env> {
  static options = { hibernate: true };

  messages = [] as ChatMessage[];

  onStart() {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, user TEXT, role TEXT, content TEXT)`,
    );

    this.messages = this.ctx.storage.sql
      .exec(`SELECT * FROM messages`)
      .toArray() as ChatMessage[];
  }

  onConnect(connection: Connection) {
    connection.send(
      JSON.stringify({
        type: "all",
        messages: this.messages,
      } satisfies Message),
    );
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

  onMessage(_connection: Connection, message: WSMessage) {
    this.broadcast(message);

    const parsed = JSON.parse(message as string) as Message;
    if (parsed.type === "add" || parsed.type === "update") {
      this.saveMessage(parsed);
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

    return (
      (await routePartykitRequest(request, { ...env })) ||
      env.ASSETS.fetch(request)
    );
  },
} satisfies ExportedHandler<Env>;
