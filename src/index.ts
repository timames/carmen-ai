import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { Env, User } from "./types";
import {
  authMiddleware,
  handleLogin,
  handleCallback,
  handleLogout,
  getSession,
  getGraphToken,
} from "./auth";
import { resolveModel, getAvailableModels } from "./ai";
import { getSystemPrompt, fetchGraphContext } from "./tools";
import { extractFileContent } from "./extract";
import { generateDocument, SUPPORTED_FORMATS } from "./generate";
import { fetchWebContext } from "./web";
import {
  isNinjaAllowed,
  getNinjaLoginUrl,
  exchangeNinjaCode,
  storeNinjaToken,
  getNinjaToken,
  fetchNinjaContext,
} from "./ninja";

type App = { Bindings: Env; Variables: { user: User } };

const app = new Hono<App>();

// ── Auth routes ──────────────────────────────────────────────
app.get("/auth/login", handleLogin as any);
app.get("/auth/callback", handleCallback as any);
app.get("/auth/logout", handleLogout as any);

app.get("/auth/status", async (c) => {
  if (!c.env.ENTRA_CLIENT_ID) {
    return c.json({
      authenticated: true,
      user: { id: "dev", email: "dev@localhost", name: "Dev User", role: "admin" },
      ninja: false,
    });
  }
  const session = await getSession(c as any);
  if (!session) return c.json({ authenticated: false });
  const dbUser = await c.env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(session.userId).first<{ role: string }>();
  const ninjaConnected = isNinjaAllowed(session.email)
    ? !!(await c.env.SESSIONS.get(`ninja:${session.userId}`))
    : false;
  return c.json({
    authenticated: true,
    user: {
      id: session.userId,
      email: session.email,
      name: session.name,
      role: dbUser?.role || "user",
    },
    ninja: ninjaConnected,
    ninjaAllowed: isNinjaAllowed(session.email),
  });
});

// ── NinjaOne OAuth ──────────────────────────────────────────
app.get("/auth/ninja/login", async (c) => {
  const session = await getSession(c as any);
  if (!session) return c.redirect("/auth/login");
  if (!isNinjaAllowed(session.email)) return c.text("Forbidden", 403);
  if (!c.env.NINJA_CLIENT_ID) return c.text("NinjaOne not configured", 500);

  const state = crypto.randomUUID();
  await c.env.SESSIONS.put(`ninja-state:${state}`, session.userId, { expirationTtl: 300 });

  const redirectUri = `${c.env.APP_URL}/auth/ninja/callback`;
  const url = getNinjaLoginUrl(c.env.NINJA_CLIENT_ID, redirectUri, state);
  return c.redirect(url);
});

app.get("/auth/ninja/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("Missing code or state", 400);

  const userId = await c.env.SESSIONS.get(`ninja-state:${state}`);
  if (!userId) return c.text("Invalid state", 400);
  await c.env.SESSIONS.delete(`ninja-state:${state}`);

  if (!c.env.NINJA_CLIENT_ID || !c.env.NINJA_CLIENT_SECRET) {
    return c.text("NinjaOne not configured", 500);
  }

  const redirectUri = `${c.env.APP_URL}/auth/ninja/callback`;
  const tokens = await exchangeNinjaCode(code, c.env.NINJA_CLIENT_ID, c.env.NINJA_CLIENT_SECRET, redirectUri);
  if (!tokens) return c.text("NinjaOne token exchange failed", 500);

  await storeNinjaToken(c.env.SESSIONS, userId, tokens);
  return c.redirect("/?ninja=connected");
});

// ── API routes (auth required) ───────────────────────────────
const api = new Hono<App>();
api.use("*", authMiddleware);

api.get("/me", (c) => c.json(c.get("user")));

api.get("/models", (c) => c.json(getAvailableModels()));

// ── Workspaces ───────────────────────────────────────────────
api.get("/workspaces", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, icon, sort_order, created_at FROM workspaces WHERE user_id = ? ORDER BY sort_order ASC, name ASC"
  )
    .bind(user.id)
    .all();
  return c.json(results);
});

api.post("/workspaces", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ name: string; icon?: string }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  const id = crypto.randomUUID();
  const icon = body.icon || "\u{1F4AC}";
  await c.env.DB.prepare(
    "INSERT INTO workspaces (id, user_id, name, icon) VALUES (?, ?, ?, ?)"
  )
    .bind(id, user.id, body.name, icon)
    .run();
  return c.json({ id, name: body.name, icon }, 201);
});

api.put("/workspaces/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json<{ name?: string; icon?: string; sort_order?: number }>();
  await c.env.DB.prepare(
    `UPDATE workspaces
     SET name = COALESCE(?, name), icon = COALESCE(?, icon), sort_order = COALESCE(?, sort_order)
     WHERE id = ? AND user_id = ?`
  )
    .bind(body.name ?? null, body.icon ?? null, body.sort_order ?? null, id, user.id)
    .run();
  return c.json({ ok: true });
});

api.delete("/workspaces/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await c.env.DB.prepare(
    "UPDATE conversations SET workspace_id = NULL, updated_at = datetime('now') WHERE workspace_id = ? AND user_id = ?"
  )
    .bind(id, user.id)
    .run();
  await c.env.DB.prepare(
    "DELETE FROM workspaces WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.id)
    .run();
  return c.json({ ok: true });
});

// ── Conversations ────────────────────────────────────────────
api.get("/conversations", async (c) => {
  const user = c.get("user");
  const workspace = c.req.query("workspace");
  let sql: string;
  let params: unknown[];

  if (workspace === "none") {
    sql = "SELECT id, title, model, workspace_id, created_at, updated_at FROM conversations WHERE user_id = ? AND workspace_id IS NULL ORDER BY updated_at DESC";
    params = [user.id];
  } else if (workspace) {
    sql = "SELECT id, title, model, workspace_id, created_at, updated_at FROM conversations WHERE user_id = ? AND workspace_id = ? ORDER BY updated_at DESC";
    params = [user.id, workspace];
  } else {
    sql = "SELECT id, title, model, workspace_id, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC";
    params = [user.id];
  }

  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

api.post("/conversations", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ title?: string; model?: string; workspace_id?: string }>();
  const id = crypto.randomUUID();
  const title = body.title || "New Chat";
  const model = body.model || "auto";
  const workspaceId = body.workspace_id || null;
  await c.env.DB.prepare(
    "INSERT INTO conversations (id, user_id, title, model, workspace_id) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, user.id, title, model, workspaceId)
    .run();
  return c.json({ id, title, model, workspace_id: workspaceId }, 201);
});

api.put("/conversations/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json<{ title?: string; model?: string; workspace_id?: string | null }>();

  const hasWorkspaceId = "workspace_id" in body;
  if (hasWorkspaceId) {
    await c.env.DB.prepare(
      `UPDATE conversations
       SET title = COALESCE(?, title), model = COALESCE(?, model), workspace_id = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`
    )
      .bind(body.title ?? null, body.model ?? null, body.workspace_id ?? null, id, user.id)
      .run();
  } else {
    await c.env.DB.prepare(
      `UPDATE conversations
       SET title = COALESCE(?, title), model = COALESCE(?, model), updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`
    )
      .bind(body.title ?? null, body.model ?? null, id, user.id)
      .run();
  }
  return c.json({ ok: true });
});

api.delete("/conversations/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await c.env.DB.prepare(
    "DELETE FROM conversations WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.id)
    .run();
  return c.json({ ok: true });
});

api.get("/conversations/:id/messages", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const conv = await c.env.DB.prepare(
    "SELECT id FROM conversations WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.id)
    .first();
  if (!conv) return c.json({ error: "Not found" }, 404);

  const { results } = await c.env.DB.prepare(
    "SELECT id, role, content, model, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC"
  )
    .bind(id)
    .all();
  return c.json(results);
});

// ── Files ────────────────────────────────────────────────────
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const TEXT_TYPES = new Set([
  "text/plain", "text/markdown", "text/csv", "text/html", "text/css",
  "text/xml", "application/json", "application/xml",
  "application/javascript", "application/typescript",
  "application/x-yaml", "application/x-sh",
]);

function isTextFile(type: string, name: string): boolean {
  if (TEXT_TYPES.has(type) || type.startsWith("text/")) return true;
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return ["ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "c", "cpp", "h",
    "cs", "rb", "php", "swift", "kt", "sql", "sh", "bash", "zsh", "ps1",
    "yaml", "yml", "toml", "ini", "cfg", "env", "md", "mdx", "txt", "csv",
    "json", "xml", "html", "css", "scss", "less", "svg", "log", "conf",
    "dockerfile", "makefile", "gitignore", "editorconfig",
  ].includes(ext);
}

api.get("/conversations/:id/files", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const conv = await c.env.DB.prepare(
    "SELECT id FROM conversations WHERE id = ? AND user_id = ?"
  ).bind(id, user.id).first();
  if (!conv) return c.json({ error: "Not found" }, 404);

  const { results } = await c.env.DB.prepare(
    "SELECT id, name, type, size, created_at FROM files WHERE conversation_id = ? ORDER BY created_at ASC"
  ).bind(id).all();
  return c.json(results);
});

api.post("/conversations/:id/files", async (c) => {
  const user = c.get("user");
  const convId = c.req.param("id");
  const conv = await c.env.DB.prepare(
    "SELECT id FROM conversations WHERE id = ? AND user_id = ?"
  ).bind(convId, user.id).first();
  if (!conv) return c.json({ error: "Not found" }, 404);

  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "No file provided" }, 400);
  if (file.size > MAX_FILE_SIZE) return c.json({ error: "File too large (max 10 MB)" }, 400);

  const fileId = crypto.randomUUID();
  const r2Key = `${user.id}/${convId}/${fileId}/${file.name}`;

  await c.env.FILES.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { originalName: file.name },
  });

  await c.env.DB.prepare(
    "INSERT INTO files (id, conversation_id, name, type, size, r2_key) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(fileId, convId, file.name, file.type, file.size, r2Key).run();

  return c.json({ id: fileId, name: file.name, type: file.type, size: file.size }, 201);
});

api.delete("/files/:id", async (c) => {
  const user = c.get("user");
  const fileId = c.req.param("id");

  const file = await c.env.DB.prepare(
    `SELECT f.id, f.r2_key, f.conversation_id FROM files f
     JOIN conversations c ON f.conversation_id = c.id
     WHERE f.id = ? AND c.user_id = ?`
  ).bind(fileId, user.id).first<{ id: string; r2_key: string }>();
  if (!file) return c.json({ error: "Not found" }, 404);

  await c.env.FILES.delete(file.r2_key);
  await c.env.DB.prepare("DELETE FROM files WHERE id = ?").bind(fileId).run();
  return c.json({ ok: true });
});

// ── Chat (streaming) ─────────────────────────────────────────
api.post("/chat", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    conversationId: string;
    message: string;
    model?: string;
  }>();

  const { conversationId, message, model: modelChoice } = body;
  if (!conversationId || !message) {
    return c.json({ error: "conversationId and message required" }, 400);
  }

  const conv = await c.env.DB.prepare(
    "SELECT id, model FROM conversations WHERE id = ? AND user_id = ?"
  )
    .bind(conversationId, user.id)
    .first<{ id: string; model: string }>();
  if (!conv) return c.json({ error: "Conversation not found" }, 404);

  const { results: history } = await c.env.DB.prepare(
    "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC"
  )
    .bind(conversationId)
    .all<{ role: string; content: string }>();

  const { results: files } = await c.env.DB.prepare(
    "SELECT name, type, r2_key FROM files WHERE conversation_id = ? ORDER BY created_at ASC"
  ).bind(conversationId).all<{ name: string; type: string; r2_key: string }>();

  let fileContext = "";
  for (const file of files) {
    const obj = await c.env.FILES.get(file.r2_key);
    if (!obj) continue;

    if (isTextFile(file.type, file.name)) {
      const text = await obj.text();
      const truncated = text.length > 50_000 ? text.slice(0, 50_000) + "\n...[truncated]" : text;
      fileContext += `\n\n--- File: ${file.name} ---\n${truncated}`;
    } else {
      const data = await obj.arrayBuffer();
      const extracted = await extractFileContent(data, file.name, file.type, c.env.AI);
      if (extracted) {
        const truncated = extracted.length > 50_000 ? extracted.slice(0, 50_000) + "\n...[truncated]" : extracted;
        fileContext += `\n\n--- File: ${file.name} ---\n${truncated}`;
      } else {
        fileContext += `\n\n--- File: ${file.name} (${file.type}, unsupported format) ---`;
      }
    }
  }

  const ninjaTokenPromise = isNinjaAllowed(user.email) && c.env.NINJA_CLIENT_ID && c.env.NINJA_CLIENT_SECRET
    ? getNinjaToken(c.env.SESSIONS, user.id, c.env.NINJA_CLIENT_ID, c.env.NINJA_CLIENT_SECRET)
    : Promise.resolve(null);

  const [graphContext, webContext, ninjaContext] = await Promise.all([
    getGraphToken(c as any).then((token) => fetchGraphContext(message, token)),
    fetchWebContext(message, c.env.BRAVE_SEARCH_API_KEY),
    ninjaTokenPromise.then((token) => fetchNinjaContext(message, token)),
  ]);

  let systemContent = getSystemPrompt();
  if (fileContext) {
    systemContent += `\n\nThe user has uploaded the following files for reference:${fileContext}`;
  }
  if (graphContext) {
    systemContent += graphContext;
  }
  if (webContext) {
    systemContent += webContext;
  }
  if (ninjaContext) {
    systemContent += ninjaContext;
  }

  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: systemContent },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: message },
  ];

  await c.env.DB.prepare(
    "INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', ?)"
  )
    .bind(crypto.randomUUID(), conversationId, message)
    .run();

  const effective = modelChoice || conv.model || "auto";
  const { model, taskType } = resolveModel(effective, messages as any);

  if (history.length === 0) {
    const title =
      message.length > 60 ? message.substring(0, 57) + "..." : message;
    await c.env.DB.prepare(
      "UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(title, conversationId)
      .run();
  }

  let aiStream: ReadableStream;
  try {
    aiStream = (await c.env.AI.run(model as any, {
      messages: messages as any,
      max_tokens: 4096,
      stream: true,
    })) as ReadableStream;
  } catch (err) {
    console.error("AI.run failed:", err);
    return c.json({ error: `AI model error: ${err}` }, 502);
  }

  let fullResponse = "";
  const assistantMsgId = crypto.randomUUID();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let streamDoneResolve: () => void;
  const streamDone = new Promise<void>((r) => {
    streamDoneResolve = r;
  });

  const outputStream = new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "meta", model, taskType })}\n\n`
        )
      );

      const reader = aiStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk =
            typeof value === "string" ? value : decoder.decode(value);

          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.response) {
                fullResponse += parsed.response;
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "token", content: parsed.response })}\n\n`
                  )
                );
              }
            } catch {
              // skip malformed chunks
            }
          }
        }
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "error", error: String(err) })}\n\n`
          )
        );
      }

      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`)
      );
      controller.close();
      streamDoneResolve();
    },
  });

  c.executionCtx.waitUntil(
    streamDone.then(async () => {
      if (fullResponse) {
        await c.env.DB.prepare(
          "INSERT INTO messages (id, conversation_id, role, content, model) VALUES (?, ?, 'assistant', ?, ?)"
        )
          .bind(assistantMsgId, conversationId, fullResponse, model)
          .run();
        await c.env.DB.prepare(
          "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?"
        )
          .bind(conversationId)
          .run();

        const inputText = messages.map((m) => String(m.content)).join("");
        const inputTokens = Math.ceil(inputText.length / 4);
        const outputTokens = Math.ceil(fullResponse.length / 4);
        await c.env.DB.prepare(
          "INSERT INTO usage (id, user_id, conversation_id, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)"
        )
          .bind(crypto.randomUUID(), user.id, conversationId, model, inputTokens, outputTokens)
          .run();
      }
    })
  );

  return new Response(outputStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// ── Document generation ──────────────────────────────
api.post("/generate", async (c) => {
  const body = await c.req.json<{ content: string; format: string; filename: string }>();
  const { content, format, filename } = body;

  if (!content || !format) {
    return c.json({ error: "content and format required" }, 400);
  }
  if (!SUPPORTED_FORMATS.includes(format.toLowerCase())) {
    return c.json({ error: `Unsupported format. Use: ${SUPPORTED_FORMATS.join(", ")}` }, 400);
  }

  try {
    const { data, mimeType } = generateDocument(content, format);
    const responseData = typeof data === "string" ? data : (data.buffer as ArrayBuffer);
    const safeName = (filename || `document.${format}`).replace(/[^a-zA-Z0-9._-]/g, "_");

    return new Response(responseData, {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename="${safeName}"`,
      },
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Admin API ────────────────────────────────────────────────
const adminGuard: MiddlewareHandler<App> = async (c, next) => {
  const user = c.get("user");
  const dbUser = await c.env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(user.id).first<{ role: string }>();
  if (dbUser?.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  await next();
};

api.get("/admin/users", adminGuard, async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.created_at,
      (SELECT COUNT(*) FROM conversations c WHERE c.user_id = u.id) AS conversations,
      (SELECT COUNT(*) FROM messages m JOIN conversations c2 ON m.conversation_id = c2.id WHERE c2.user_id = u.id) AS messages,
      (SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM usage ug WHERE ug.user_id = u.id) AS tokens,
      (SELECT MAX(c3.updated_at) FROM conversations c3 WHERE c3.user_id = u.id) AS last_active
    FROM users u ORDER BY last_active DESC
  `).all();
  return c.json(results);
});

api.get("/admin/usage/daily", adminGuard, async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT DATE(created_at) AS date,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(input_tokens + output_tokens) AS total_tokens,
      COUNT(*) AS requests
    FROM usage
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `).all();
  return c.json(results);
});

api.get("/admin/conversations", adminGuard, async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT c.id, c.title, c.model, c.updated_at, u.name AS user_name, u.email AS user_email,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
    FROM conversations c
    JOIN users u ON c.user_id = u.id
    ORDER BY c.updated_at DESC
    LIMIT 50
  `).all();
  return c.json(results);
});

// ── Graph API proxy ──────────────────────────────────────────
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

api.all("/graph/*", async (c) => {
  const graphPath = c.req.path.replace(/^\/api\/graph/, "");
  const token = await getGraphToken(c as any);
  if (!token) return c.json({ error: "No Graph token available" }, 401);

  const url = `${GRAPH_BASE}${graphPath}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  const contentType = c.req.header("content-type");
  if (contentType) headers["Content-Type"] = contentType;

  const init: RequestInit = {
    method: c.req.method,
    headers,
  };

  if (!["GET", "HEAD"].includes(c.req.method)) {
    init.body = await c.req.arrayBuffer();
  }

  const graphRes = await fetch(url, init);

  return new Response(graphRes.body, {
    status: graphRes.status,
    headers: {
      "Content-Type": graphRes.headers.get("Content-Type") || "application/json",
    },
  });
});

app.route("/api", api);

export default app;
