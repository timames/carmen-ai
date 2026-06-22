import type { Context, MiddlewareHandler } from "hono";
import type { Env, Session, User } from "./types";

const ENTRA_BASE = "https://login.microsoftonline.com";
const SESSION_TTL = 60 * 60 * 24; // 24 hours

// Login scopes — OIDC basics + Graph permissions
const LOGIN_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "Mail.Read",
  "Mail.ReadWrite",
  "Chat.Read",
  "ChannelMessage.Read.All",
  "Files.ReadWrite.All",
  "Sites.ReadWrite.All",
  "OnlineMeetingTranscript.Read.All",
  "Calendars.ReadWrite",
].join(" ");

type AppContext = Context<{ Bindings: Env; Variables: { user: User } }>;

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(decoded);
}

function getSessionIdFromCookie(c: Context): string | null {
  const cookies = c.req.header("cookie") || "";
  const match = cookies.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

export async function getSession(
  c: AppContext
): Promise<Session | null> {
  const sessionId = getSessionIdFromCookie(c);
  if (!sessionId) return null;

  const data = await c.env.SESSIONS.get(`session:${sessionId}`);
  if (!data) return null;

  const session: Session = JSON.parse(data);
  if (Date.now() > session.expiresAt) {
    await c.env.SESSIONS.delete(`session:${sessionId}`);
    return null;
  }
  return session;
}

export async function handleLogin(c: AppContext): Promise<Response> {
  const state = crypto.randomUUID();
  await c.env.SESSIONS.put(`state:${state}`, "1", { expirationTtl: 300 });

  const params = new URLSearchParams({
    client_id: c.env.ENTRA_CLIENT_ID,
    response_type: "code",
    redirect_uri: `${c.env.APP_URL}/auth/callback`,
    scope: LOGIN_SCOPES,
    state,
    response_mode: "query",
  });

  return c.redirect(
    `${ENTRA_BASE}/${c.env.ENTRA_TENANT_ID}/oauth2/v2.0/authorize?${params}`
  );
}

export async function handleCallback(c: AppContext): Promise<Response> {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) return c.text("Missing code or state", 400);

  const storedState = await c.env.SESSIONS.get(`state:${state}`);
  if (!storedState) return c.text("Invalid state", 400);
  await c.env.SESSIONS.delete(`state:${state}`);

  const tokenRes = await fetch(
    `${ENTRA_BASE}/${c.env.ENTRA_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: c.env.ENTRA_CLIENT_ID,
        client_secret: c.env.ENTRA_CLIENT_SECRET,
        code,
        redirect_uri: `${c.env.APP_URL}/auth/callback`,
        grant_type: "authorization_code",
        scope: LOGIN_SCOPES,
      }),
    }
  );

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return c.text(`Token exchange failed: ${err}`, 500);
  }

  const tokens = (await tokenRes.json()) as {
    id_token: string;
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  const claims = decodeJwtPayload(tokens.id_token);

  const userId = (claims.oid || claims.sub) as string;
  const email = (claims.email || claims.preferred_username || "") as string;
  const name = (claims.name || email) as string;

  // Auto-assign admin role to designated admins
  const ADMIN_EMAILS = ["tames@cardinalservicesltd.com", "rosal.jeffrey@cardinalservicesltd.com"];
  const role = ADMIN_EMAILS.includes(email.toLowerCase()) ? "admin" : "user";

  await c.env.DB.prepare(
    `INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, role = CASE WHEN excluded.role = 'admin' THEN 'admin' ELSE users.role END`
  )
    .bind(userId, email, name, role)
    .run();

  const sessionId = crypto.randomUUID();
  const session: Session = {
    userId,
    email,
    name,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || "",
    tokenExpiresAt: Date.now() + tokens.expires_in * 1000,
    expiresAt: Date.now() + SESSION_TTL * 1000,
  };
  await c.env.SESSIONS.put(
    `session:${sessionId}`,
    JSON.stringify(session),
    { expirationTtl: SESSION_TTL }
  );

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": `session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`,
    },
  });
}

export async function handleLogout(c: AppContext): Promise<Response> {
  const sessionId = getSessionIdFromCookie(c);
  if (sessionId) {
    await c.env.SESSIONS.delete(`session:${sessionId}`);
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie":
        "session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    },
  });
}

/** Refresh the access token using the refresh token */
async function refreshAccessToken(
  c: AppContext,
  session: Session,
  sessionId: string
): Promise<string | null> {
  if (!session.refreshToken) return null;

  const tokenRes = await fetch(
    `${ENTRA_BASE}/${c.env.ENTRA_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: c.env.ENTRA_CLIENT_ID,
        client_secret: c.env.ENTRA_CLIENT_SECRET,
        refresh_token: session.refreshToken,
        grant_type: "refresh_token",
        scope: LOGIN_SCOPES,
      }),
    }
  );

  if (!tokenRes.ok) return null;

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  session.accessToken = tokens.access_token;
  if (tokens.refresh_token) session.refreshToken = tokens.refresh_token;
  session.tokenExpiresAt = Date.now() + tokens.expires_in * 1000;

  await c.env.SESSIONS.put(
    `session:${sessionId}`,
    JSON.stringify(session),
    { expirationTtl: SESSION_TTL }
  );

  return tokens.access_token;
}

/** Get a valid Graph access token, refreshing if needed */
export async function getGraphToken(
  c: AppContext
): Promise<string | null> {
  const sessionId = getSessionIdFromCookie(c);
  if (!sessionId) return null;

  const data = await c.env.SESSIONS.get(`session:${sessionId}`);
  if (!data) return null;

  const session: Session = JSON.parse(data);

  // Token still valid (with 5 min buffer)
  if (session.accessToken && Date.now() < session.tokenExpiresAt - 300_000) {
    return session.accessToken;
  }

  // Try refresh
  return refreshAccessToken(c, session, sessionId);
}

export const authMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: { user: User };
}> = async (c, next) => {
  // Dev bypass: if ENTRA_CLIENT_ID is not set, skip auth
  if (!c.env.ENTRA_CLIENT_ID) {
    const devUser = { id: "dev", email: "dev@localhost", name: "Dev User", role: "admin" };
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(devUser.id, devUser.email, devUser.name, devUser.role).run();
    c.set("user", devUser);
    return next();
  }

  const session = await getSession(c as unknown as AppContext);
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("user", {
    id: session.userId,
    email: session.email,
    name: session.name,
    role: "user",
  });
  return next();
};
