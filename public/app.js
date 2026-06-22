/* Carmen AI — Frontend */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  user: null,
  workspaces: [],
  currentWorkspace: null,
  conversations: [],
  currentId: null,
  messages: [],
  files: [],
  streaming: false,
};

// ── API helpers ──────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });
  if (res.status === 401) {
    window.location.href = "/auth/login";
    return null;
  }
  return res;
}

async function apiJson(path, opts) {
  const res = await api(path, opts);
  return res ? res.json() : null;
}

// ── Init ─────────────────────────────────────────

async function init() {
  const status = await fetch("/auth/status").then((r) => r.json());
  if (!status.authenticated) {
    $("#login-screen").style.display = "";
    return;
  }

  state.user = status.user;
  $("#login-screen").style.display = "none";
  $("#sidebar").style.display = "";
  $("#chat-area").style.display = "";
  $("#user-name").textContent = state.user.name;

  if (status.ninjaAllowed) {
    const footer = $(".sidebar-footer");
    if (status.ninja) {
      footer.insertAdjacentHTML("beforeend", '<span class="ninja-badge" title="NinjaOne connected">🥷</span>');
    } else {
      footer.insertAdjacentHTML("beforeend", '<a href="/auth/ninja/login" class="ninja-connect-btn" title="Connect NinjaOne RMM">🥷 Connect</a>');
    }
  }

  if (location.search.includes("ninja=connected")) {
    history.replaceState(null, "", "/");
  }

  await loadWorkspaces();
  await loadConversations();
  bindEvents();
}

// ── Workspaces ───────────────────────────────────

const EMOJI_PALETTE = [
  "💬","📁","🏗️","🔧","📋","📊","🧪","🎯","💡","🚀",
  "📝","🔍","⚙️","📌","🏠","🌐","🔒","📅","👥","🤖",
  "⭐","🔥","💼","📦","🎨","🧩","📈","🛠️","💻","📖",
];

async function loadWorkspaces() {
  const data = await apiJson("/workspaces");
  state.workspaces = data || [];
  renderWorkspaceTabs();
}

function renderWorkspaceTabs() {
  const el = $("#workspace-tabs");
  if (!el) return;

  const allActive = state.currentWorkspace === null ? "active" : "";
  let html = `<button class="ws-tab ${allActive}" data-ws="all">All</button>`;

  for (const ws of state.workspaces) {
    const active = state.currentWorkspace === ws.id ? "active" : "";
    html += `<button class="ws-tab ${active}" data-ws="${ws.id}" title="${escapeHtml(ws.name)}">${ws.icon} ${escapeHtml(ws.name)}</button>`;
  }

  html += `<button class="ws-tab ws-add" data-ws="add" title="New workspace">+</button>`;

  el.innerHTML = html;

  el.querySelectorAll(".ws-tab").forEach((tab) => {
    tab.addEventListener("click", async () => {
      const ws = tab.dataset.ws;
      if (ws === "add") {
        showWorkspaceDialog();
        return;
      }
      state.currentWorkspace = ws === "all" ? null : ws;
      renderWorkspaceTabs();
      await loadConversations();
    });

    if (tab.dataset.ws !== "all" && tab.dataset.ws !== "add") {
      tab.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showWorkspaceContextMenu(e, tab.dataset.ws);
      });
    }
  });
}

function showWorkspaceDialog(editId) {
  const existing = editId ? state.workspaces.find((w) => w.id === editId) : null;
  const title = existing ? "Edit Workspace" : "New Workspace";

  const old = $("#ws-dialog-overlay");
  if (old) old.remove();

  const overlay = document.createElement("div");
  overlay.id = "ws-dialog-overlay";
  overlay.innerHTML = `
    <div class="ws-dialog">
      <h3>${title}</h3>
      <div class="ws-emoji-section">
        <label>Icon</label>
        <div class="ws-emoji-grid">
          ${EMOJI_PALETTE.map((e) => `<button type="button" class="ws-emoji-btn${e === (existing?.icon || "💬") ? " selected" : ""}" data-emoji="${e}">${e}</button>`).join("")}
        </div>
      </div>
      <label>Name</label>
      <input type="text" id="ws-name-input" value="${escapeHtml(existing?.name || "")}" placeholder="Workspace name" maxlength="30" />
      <div class="ws-dialog-actions">
        <button type="button" class="ws-cancel-btn">Cancel</button>
        <button type="button" class="ws-save-btn">${existing ? "Save" : "Create"}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  let selectedEmoji = existing?.icon || "💬";

  overlay.querySelectorAll(".ws-emoji-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      overlay.querySelectorAll(".ws-emoji-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      selectedEmoji = btn.dataset.emoji;
    });
  });

  overlay.querySelector(".ws-cancel-btn").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector(".ws-save-btn").addEventListener("click", async () => {
    const name = overlay.querySelector("#ws-name-input").value.trim();
    if (!name) return;

    if (editId) {
      await apiJson(`/workspaces/${editId}`, {
        method: "PUT",
        body: JSON.stringify({ name, icon: selectedEmoji }),
      });
    } else {
      await apiJson("/workspaces", {
        method: "POST",
        body: JSON.stringify({ name, icon: selectedEmoji }),
      });
    }
    overlay.remove();
    await loadWorkspaces();
  });

  setTimeout(() => overlay.querySelector("#ws-name-input").focus(), 50);
}

function showWorkspaceContextMenu(e, wsId) {
  const old = $("#ws-context-menu");
  if (old) old.remove();

  const menu = document.createElement("div");
  menu.id = "ws-context-menu";
  menu.innerHTML = `
    <button data-action="edit">✏️ Edit</button>
    <button data-action="delete" class="danger">🗑️ Delete</button>
  `;
  menu.style.left = e.clientX + "px";
  menu.style.top = e.clientY + "px";
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + "px";
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + "px";

  const close = () => menu.remove();
  setTimeout(() => document.addEventListener("click", close, { once: true }), 0);

  menu.querySelector('[data-action="edit"]').addEventListener("click", (ev) => {
    ev.stopPropagation();
    close();
    showWorkspaceDialog(wsId);
  });

  menu.querySelector('[data-action="delete"]').addEventListener("click", async (ev) => {
    ev.stopPropagation();
    close();
    const ws = state.workspaces.find((w) => w.id === wsId);
    if (!confirm(`Delete workspace "${ws?.name}"? Conversations will be moved to All.`)) return;
    await api(`/workspaces/${wsId}`, { method: "DELETE" });
    if (state.currentWorkspace === wsId) state.currentWorkspace = null;
    await loadWorkspaces();
    await loadConversations();
  });
}

// ── Conversations ────────────────────────────────

async function loadConversations() {
  const wsParam = state.currentWorkspace ? `?workspace=${state.currentWorkspace}` : "";
  const data = await apiJson(`/conversations${wsParam}`);
  state.conversations = data || [];
  renderConversationList();
}

function renderConversationList() {
  const el = $("#conversation-list");
  if (state.conversations.length === 0) {
    el.innerHTML =
      '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:0.85rem">No conversations yet</div>';
    return;
  }

  el.innerHTML = state.conversations
    .map(
      (c) => `
    <div class="conv-item ${c.id === state.currentId ? "active" : ""}" data-id="${c.id}">
      <span class="title">${escapeHtml(c.title)}</span>
      <button class="delete-btn" data-id="${c.id}" title="Delete">&times;</button>
    </div>
  `
    )
    .join("");

  el.querySelectorAll(".conv-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      if (e.target.classList.contains("delete-btn")) return;
      selectConversation(item.dataset.id);
    });
  });

  el.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteConversation(btn.dataset.id);
    });
  });
}

async function selectConversation(id) {
  state.currentId = id;
  $("#sidebar").classList.remove("open");
  $("#sidebar-overlay").classList.remove("open");
  renderConversationList();

  const data = await apiJson(`/conversations/${id}/messages`);
  state.messages = data || [];

  const conv = state.conversations.find((c) => c.id === id);
  if (conv) {
    $("#model-select").value = conv.model || "auto";
  }

  await loadFiles(id);
  renderMessages();
}

async function createConversation() {
  const model = $("#model-select").value;
  const wsId = state.currentWorkspace && state.currentWorkspace !== "none" ? state.currentWorkspace : null;
  const data = await apiJson("/conversations", {
    method: "POST",
    body: JSON.stringify({ model, workspace_id: wsId }),
  });
  if (!data) return;

  state.conversations.unshift({
    id: data.id,
    title: data.title,
    model: data.model,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  state.currentId = data.id;
  state.messages = [];
  state.files = [];
  renderConversationList();
  renderMessages();
  renderFiles();
  $("#message-input").focus();
}

async function deleteConversation(id) {
  await api(`/conversations/${id}`, { method: "DELETE" });
  state.conversations = state.conversations.filter((c) => c.id !== id);
  if (state.currentId === id) {
    state.currentId = null;
    state.messages = [];
    state.files = [];
  }
  renderConversationList();
  renderMessages();
  renderFiles();
}

// ── Messages ─────────────────────────────────────

function renderMessages() {
  const messagesEl = $("#messages");
  const welcomeEl = $("#welcome-screen");

  if (!state.currentId) {
    messagesEl.style.display = "none";
    welcomeEl.style.display = "";
    $("#model-badge").textContent = "";
    return;
  }

  welcomeEl.style.display = "none";
  messagesEl.style.display = "";

  messagesEl.innerHTML = state.messages
    .map((m, i) => {
      let html = `
    <div class="message ${m.role}">
      <div class="role-label">${m.role === "user" ? "You" : "Carmen"}</div>
      <div class="content">${renderMarkdown(m.content)}</div>
    </div>`;

      if (m.role === "assistant" && !m.content.includes("```document:") && m.content.length > 50) {
        const prevUser = state.messages.slice(0, i).reverse().find((p) => p.role === "user");
        const fmt = detectRequestedFormat(prevUser?.content);
        if (fmt) {
          html += buildDownloadBlock(prevUser.content, m.content, fmt);
        }
      }
      return html;
    })
    .join("");

  addCopyButtons();
  highlightCode();
  scrollToBottom();
}

function appendStreamingMessage() {
  const messagesEl = $("#messages");
  const div = document.createElement("div");
  div.className = "message assistant";
  div.id = "streaming-msg";
  div.innerHTML = `
    <div class="role-label">Carmen</div>
    <div class="content streaming-cursor"></div>
  `;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function appendToken(token) {
  const el = document.querySelector("#streaming-msg .content");
  if (!el) return;
  el._rawContent = (el._rawContent || "") + token;
  el.innerHTML = renderMarkdown(el._rawContent);
  addCopyButtons(el);
  highlightCode(el);
  scrollToBottom();
}

function buildDownloadBlock(userMessage, content, format) {
  const nameWords = (userMessage || "document")
    .replace(/\b(create|make|generate|build|write|in|a|an|the|as|docx|xlsx|pptx|word|excel|powerpoint|markdown|file|document|format|please|can|you|me)\b/gi, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 50) || "document";
  const filename = `${nameWords}.${format}`;
  const id = "doc-auto-" + Math.random().toString(36).slice(2, 10);
  const icons = { docx: "\u{1F4C4}", xlsx: "\u{1F4CA}", pptx: "\u{1F4CA}", md: "\u{1F4DD}" };

  if (!window._docBlocks) window._docBlocks = {};
  window._docBlocks[id] = { filename, content, format };

  return `<div class="doc-download-block" data-doc-id="${id}">
    <div class="doc-download-icon">${icons[format] || "\u{1F4C4}"}</div>
    <div class="doc-download-info">
      <span class="doc-download-name">${escapeHtml(filename)}</span>
      <span class="doc-download-hint">Click to download</span>
    </div>
    <button class="doc-download-btn" data-doc-id="${id}">Download</button>
  </div>`;
}

function detectRequestedFormat(userMessage) {
  if (!userMessage) return null;
  const lower = userMessage.toLowerCase();
  const formats = [
    { ext: "docx", patterns: [/\bdocx\b/, /\bword\s+doc/, /\b\.docx\b/, /\bin\s+word\b/, /\bas\s+a?\s*word\b/] },
    { ext: "xlsx", patterns: [/\bxlsx\b/, /\bexcel\b/, /\bspreadsheet\b/, /\b\.xlsx\b/] },
    { ext: "pptx", patterns: [/\bpptx\b/, /\bpowerpoint\b/, /\bpresentation\b/, /\b\.pptx\b/] },
    { ext: "md",   patterns: [/\bmarkdown\s+file\b/, /\b\.md\b/] },
  ];
  for (const f of formats) {
    for (const p of f.patterns) {
      if (p.test(lower)) return f.ext;
    }
  }
  return null;
}

function finalizeStreaming() {
  const el = document.querySelector("#streaming-msg .content");
  const msg = $("#streaming-msg");
  if (el) {
    el.classList.remove("streaming-cursor");
    const raw = el._rawContent || "";
    state.messages.push({ role: "assistant", content: raw });

    const lastUserMsg = [...state.messages].reverse().find((m) => m.role === "user");
    const requestedFormat = detectRequestedFormat(lastUserMsg?.content);
    if (requestedFormat && !raw.includes("```document:") && raw.length > 50 && msg) {
      msg.insertAdjacentHTML("afterend", buildDownloadBlock(lastUserMsg.content, raw, requestedFormat));
      addCopyButtons();
    }
  }
  if (msg) msg.removeAttribute("id");
}

// ── Files ────────────────────────────────────────

async function loadFiles(convId) {
  if (!convId) { state.files = []; renderFiles(); return; }
  const data = await apiJson(`/conversations/${convId}/files`);
  state.files = data || [];
  renderFiles();
}

async function uploadFile(file) {
  if (!state.currentId) await createConversation();

  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`/api/conversations/${state.currentId}/files`, {
    method: "POST",
    body: formData,
  });
  if (res.status === 401) { window.location.href = "/auth/login"; return; }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Upload failed" }));
    alert(err.error || "Upload failed");
    return;
  }
  const data = await res.json();
  state.files.push(data);
  renderFiles();
}

async function deleteFile(fileId) {
  await api(`/files/${fileId}`, { method: "DELETE" });
  state.files = state.files.filter((f) => f.id !== fileId);
  renderFiles();
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function renderFiles() {
  const el = $("#file-list");
  if (!el) return;
  if (state.files.length === 0) {
    el.innerHTML = "";
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  el.innerHTML = state.files
    .map(
      (f) => `
    <div class="file-chip" data-id="${f.id}">
      <span class="file-icon">&#128196;</span>
      <span class="file-name">${escapeHtml(f.name)}</span>
      <span class="file-size">${formatFileSize(f.size)}</span>
      <button class="file-remove" data-id="${f.id}" title="Remove">&times;</button>
    </div>
  `
    )
    .join("");

  el.querySelectorAll(".file-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteFile(btn.dataset.id);
    });
  });
}

// ── Chat / Streaming ────────────────────────────

async function sendMessage(content) {
  if (state.streaming || !content.trim()) return;

  if (!state.currentId) {
    await createConversation();
  }

  state.messages.push({ role: "user", content });
  renderMessages();

  state.streaming = true;
  $("#send-btn").disabled = true;
  appendStreamingMessage();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: state.currentId,
        message: content,
        model: $("#model-select").value,
      }),
    });

    if (res.status === 401) {
      window.location.href = "/auth/login";
      return;
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: "Unknown error" }));
      appendToken(`**Error (${res.status}):** ${errBody.error || "Something went wrong"}`);
      finalizeStreaming();
      state.streaming = false;
      $("#send-btn").disabled = false;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "token") {
            appendToken(parsed.content);
          } else if (parsed.type === "meta") {
            $("#model-badge").textContent = `${parsed.taskType} → ${parsed.model.split("/").pop()}`;
          } else if (parsed.type === "error") {
            appendToken(`\n\n**Error:** ${parsed.error}`);
          }
        } catch {
          // skip
        }
      }
    }
  } catch (err) {
    appendToken(`\n\n**Connection error:** ${err.message}`);
  }

  finalizeStreaming();
  state.streaming = false;
  $("#send-btn").disabled = false;
  $("#message-input").focus();

  await loadConversations();
}

// ── Markdown ─────────────────────────────────────

function renderMarkdown(text) {
  if (!text) return "";

  text = text.replace(
    /<think>([\s\S]*?)<\/think>/g,
    '<details class="thinking-block"><summary>Thinking...</summary>\n\n$1\n\n</details>'
  );

  text = text.replace(
    /```document:([^\n]+)\n([\s\S]*?)```/g,
    (_, filename, content) => {
      const ext = filename.split(".").pop().toLowerCase();
      const id = "doc-" + Math.random().toString(36).slice(2, 10);
      const icons = { docx: "\u{1F4C4}", xlsx: "\u{1F4CA}", pptx: "\u{1F4CA}", md: "\u{1F4DD}" };
      const icon = icons[ext] || "\u{1F4C4}";
      if (!window._docBlocks) window._docBlocks = {};
      window._docBlocks[id] = { filename: filename.trim(), content: content.trim(), format: ext };
      return `<div class="doc-download-block" data-doc-id="${id}">
        <div class="doc-download-icon">${icon}</div>
        <div class="doc-download-info">
          <span class="doc-download-name">${escapeHtml(filename.trim())}</span>
          <span class="doc-download-hint">Click to download</span>
        </div>
        <button class="doc-download-btn" data-doc-id="${id}">Download</button>
      </div>`;
    }
  );

  try {
    return marked.parse(text, { breaks: true, gfm: true });
  } catch {
    return escapeHtml(text);
  }
}

function highlightCode(root) {
  (root || document).querySelectorAll("pre code").forEach((block) => {
    if (!block.dataset.highlighted) {
      hljs.highlightElement(block);
    }
  });
}

function addCopyButtons(root) {
  (root || document).querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".code-copy-btn")) return;
    const btn = document.createElement("button");
    btn.className = "code-copy-btn";
    btn.textContent = "Copy";
    btn.addEventListener("click", () => {
      const code = pre.querySelector("code");
      navigator.clipboard.writeText(code ? code.textContent : pre.textContent);
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = "Copy"), 1500);
    });
    pre.style.position = "relative";
    pre.appendChild(btn);
  });

  (root || document).querySelectorAll(".doc-download-btn").forEach((btn) => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      const id = btn.dataset.docId;
      const doc = window._docBlocks?.[id];
      if (!doc) return;

      btn.textContent = "Generating...";
      btn.disabled = true;

      try {
        const res = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: doc.content,
            format: doc.format,
            filename: doc.filename,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Generation failed" }));
          throw new Error(err.error || "Generation failed");
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = doc.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        btn.textContent = "Downloaded!";
        setTimeout(() => {
          btn.textContent = "Download";
          btn.disabled = false;
        }, 2000);
      } catch (err) {
        btn.textContent = "Error";
        setTimeout(() => {
          btn.textContent = "Download";
          btn.disabled = false;
        }, 2000);
      }
    });
  });
}

function scrollToBottom() {
  const el = $("#messages");
  if (el) el.scrollTop = el.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ── Events ───────────────────────────────────────

function bindEvents() {
  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#message-input");
    const content = input.value.trim();
    if (content) {
      input.value = "";
      input.style.height = "auto";
      sendMessage(content);
    }
  });

  const input = $("#message-input");
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("#chat-form").dispatchEvent(new Event("submit"));
    }
  });

  $("#new-chat-btn").addEventListener("click", () => {
    state.currentId = null;
    state.messages = [];
    renderConversationList();
    renderMessages();
    $("#message-input").focus();
  });

  $("#logout-btn").addEventListener("click", () => {
    window.location.href = "/auth/logout";
  });

  $("#attach-btn").addEventListener("click", () => {
    $("#file-input").click();
  });

  $("#file-input").addEventListener("change", (e) => {
    for (const file of e.target.files) {
      uploadFile(file);
    }
    e.target.value = "";
  });

  const chatArea = $("#chat-area");
  chatArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    chatArea.classList.add("drag-over");
  });
  chatArea.addEventListener("dragleave", () => {
    chatArea.classList.remove("drag-over");
  });
  chatArea.addEventListener("drop", (e) => {
    e.preventDefault();
    chatArea.classList.remove("drag-over");
    for (const file of e.dataTransfer.files) {
      uploadFile(file);
    }
  });

  $("#menu-btn").addEventListener("click", () => {
    $("#sidebar").classList.toggle("open");
    $("#sidebar-overlay").classList.toggle("open");
  });

  $("#sidebar-overlay").addEventListener("click", () => {
    $("#sidebar").classList.remove("open");
    $("#sidebar-overlay").classList.remove("open");
  });

  $("#model-select").addEventListener("change", async () => {
    if (state.currentId) {
      await api(`/conversations/${state.currentId}`, {
        method: "PUT",
        body: JSON.stringify({ model: $("#model-select").value }),
      });
    }
  });
}

// ── Service Worker ───────────────────────────────

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}

// ── Boot ─────────────────────────────────────────

init();
