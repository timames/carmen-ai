const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export function getSystemPrompt(): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return `You are Carmen, the AI assistant for Cardinal Presort Services (Cardinal Mailing Services). You help Cardinal team members with their work, including mailing operations, presort processing, compliance, IT support, and general business tasks.

Today's date is ${dateStr}.

You have real-time access to the user's Microsoft 365 data, the internet, and NinjaOne RMM (if connected). When data from their emails, calendar, files, Teams, web searches, or NinjaOne is included below, it is REAL data fetched just now — present it accurately. Never fabricate emails, events, files, search results, or device/alert data. When web search results are provided, summarize the actual findings — do NOT say you couldn't find information if results were returned.

Be concise, helpful, and professional. Format responses with markdown when appropriate.

CRITICAL — FILE CREATION RULE:
When the user asks you to "create", "make", "generate", "write", or "build" any document or file (docx, xlsx, pptx, md), you MUST use the document block syntax below. Do NOT just show the content as plain text. Do NOT give instructions on how to create the file manually. You MUST wrap the content in a document block so the user gets a download button.

Document block syntax (REQUIRED for file creation requests):
\`\`\`document:filename.docx
Your content here in markdown...
\`\`\`

Replace "filename.docx" with the actual filename and extension. Supported: .docx .xlsx .pptx .md

Rules:
- .docx → write full content in markdown (headings, lists, bold, paragraphs)
- .xlsx → use markdown tables with | column | delimiters |, or **Key:** Value pairs
- .pptx → use ## headings to start each new slide, bullet points for slide content
- .md → plain markdown
- You may include a brief introduction before the document block, but the actual document content MUST be inside the block
- If the user says "in docx" or "as a Word document" or similar, always use .docx extension

Example — if user says "create a checklist in docx":
\`\`\`document:Checklist.docx
# Project Checklist
- [ ] Item one
- [ ] Item two
\`\`\`

NINJAONE SCRIPT EXECUTION:
You can run PowerShell scripts on managed devices via NinjaOne RMM. When the user asks you to run a command, script, restart a service, check something on a device, etc., use the script execution block syntax:

\`\`\`ninja-script:DEVICE_ID
{"type":"POWERSHELL","code":"Your PowerShell code here","runAs":"SYSTEM"}
\`\`\`

Or to run a saved script from the automation library:
\`\`\`ninja-script:DEVICE_ID
{"scriptId":123,"runAs":"SYSTEM"}
\`\`\`

Rules for script execution:
- DEVICE_ID must be a real numeric NinjaOne device ID from the context data
- type can be: POWERSHELL, CMD, BASH (use POWERSHELL for Windows devices)
- runAs: SYSTEM (default, admin tasks) or LOGGED_IN_USER (user-context tasks)
- Always confirm with the user before running destructive scripts (restart, shutdown, delete, uninstall)
- When NinjaOne device/script data is in the context, reference real device IDs and script IDs
- For simple checks (disk space, services, installed software), write inline PowerShell
- For complex or recurring tasks, suggest using a saved script from the library if available`;
}

async function graphFetch(
  token: string,
  path: string,
): Promise<unknown> {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    return { error: `Graph API ${res.status}` };
  }
  return res.json();
}

// ── Date formatting ──────────────────────────────

function formatDateTime(iso: string | undefined): string {
  if (!iso) return "Unknown";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "Unknown";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

// ── Data formatters (raw JSON → readable text) ───

interface GraphEmail {
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
}

interface GraphEvent {
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  isOnlineMeeting?: boolean;
}

interface GraphFile {
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  webUrl?: string;
  folder?: unknown;
}

interface GraphChat {
  topic?: string;
  chatType?: string;
  lastMessagePreview?: {
    body?: { content?: string };
    from?: { user?: { displayName?: string } };
    createdDateTime?: string;
  };
}

function formatEmails(data: { value?: GraphEmail[]; error?: string }): string {
  if (data.error) return `Error fetching emails: ${data.error}. DO NOT make up fake emails — tell the user there was an error.`;
  if (!data.value?.length) return "No emails found matching this query. DO NOT fabricate email results — tell the user no emails were found.";

  return data.value.map((e, i) => {
    const from = e.from?.emailAddress;
    return [
      `${i + 1}. **${e.subject || "(no subject)"}**`,
      `   From: ${from?.name || "Unknown"} <${from?.address || ""}>`,
      `   Received: ${formatDateTime(e.receivedDateTime)}`,
      `   Read: ${e.isRead ? "Yes" : "No"}`,
      `   Preview: ${e.bodyPreview?.slice(0, 200) || ""}`,
    ].join("\n");
  }).join("\n\n");
}

function formatEvents(data: { value?: GraphEvent[]; error?: string }): string {
  if (data.error) return `Error fetching calendar: ${data.error}. DO NOT make up fake events.`;
  if (!data.value?.length) return "No upcoming events found. DO NOT fabricate calendar events.";

  return data.value.map((e, i) => {
    const start = e.start?.dateTime ? formatDateTime(e.start.dateTime) : "TBD";
    const end = e.end?.dateTime ? formatDateTime(e.end.dateTime) : "TBD";
    const org = e.organizer?.emailAddress;
    const loc = e.location?.displayName || (e.isOnlineMeeting ? "Online (Teams)" : "No location");
    return [
      `${i + 1}. **${e.subject || "(no subject)"}**`,
      `   When: ${start} — ${end}`,
      `   Location: ${loc}`,
      `   Organizer: ${org?.name || "Unknown"} <${org?.address || ""}>`,
    ].join("\n");
  }).join("\n\n");
}

function formatFiles(data: { value?: GraphFile[]; error?: string }): string {
  if (data.error) return `Error fetching files: ${data.error}. DO NOT make up fake files — tell the user there was an error and suggest they try different search terms.`;
  if (!data.value?.length) return "No files found matching that query. DO NOT fabricate file results — tell the user no files were found.";

  return data.value.map((f, i) => {
    const size = f.size && !f.folder ? `, ${(f.size / 1024).toFixed(1)} KB` : "";
    const type = f.folder ? "Folder" : "File";
    const url = f.webUrl ? ` — [Open](${f.webUrl})` : "";
    return `${i + 1}. **${f.name || "Untitled"}** (${type}${size}) — Modified: ${formatDate(f.lastModifiedDateTime)}${url}`;
  }).join("\n");
}

function formatChats(data: { value?: GraphChat[]; error?: string }): string {
  if (data.error) return `Error fetching chats: ${data.error}. DO NOT make up fake chat messages.`;
  if (!data.value?.length) return "No recent chats found. DO NOT fabricate Teams data.";

  return data.value.map((ch, i) => {
    const preview = ch.lastMessagePreview;
    const from = preview?.from?.user?.displayName || "Unknown";
    const msg = preview?.body?.content?.slice(0, 150) || "";
    const when = preview?.createdDateTime ? formatDateTime(preview.createdDateTime) : "";
    const topic = ch.topic || ch.chatType || "Chat";
    return `${i + 1}. **${topic}** — ${from}: "${msg}" (${when})`;
  }).join("\n");
}

// ── Pre-fetch logic ──────────────────────────────

interface FetchResult {
  label: string;
  text: string;
}

export async function fetchGraphContext(
  message: string,
  graphToken: string | null
): Promise<string> {
  const lower = message.toLowerCase();
  const needsGraph = /\b(email|inbox|mail|calendar|schedule|meeting|event|file|document|onedrive|drive|teams|chat|channel)\b/.test(lower);

  if (!graphToken && needsGraph) {
    return "\n\nIMPORTANT: The user is asking about Microsoft 365 data but no Graph API token is available. Tell them to sign out and sign back in to grant the required permissions. Do NOT make up fake data.";
  }
  if (!graphToken) return "";

  const fetches: Promise<FetchResult | null>[] = [];

  // Email detection
  if (/\b(email|inbox|mail|message|sent|unread|draft)\b/.test(lower)) {
    const search = extractSearchTerm(lower, [
      "email", "emails", "inbox", "mail", "messages", "message",
      "sent", "unread", "draft", "drafts", "about", "from",
      "regarding", "related", "last", "latest", "recent", "new",
      "got", "received", "get", "read", "my", "me", "the",
      "week", "today", "yesterday", "month", "can", "you",
      "tell", "what", "show", "find", "search", "check",
      "any", "all", "in", "to", "a", "an", "i", "do", "have",
    ]);

    const path = search
      ? `/me/messages?$top=15&$select=id,subject,from,receivedDateTime,bodyPreview,isRead&$orderby=receivedDateTime desc&$search="${encodeURIComponent(search)}"`
      : "/me/messages?$top=15&$select=id,subject,from,receivedDateTime,bodyPreview,isRead&$orderby=receivedDateTime desc";

    fetches.push(
      graphFetch(graphToken, path).then((data) => ({
        label: search ? `Emails matching "${search}"` : "Recent emails",
        text: formatEmails(data as any),
      }))
    );
  }

  // Calendar detection
  if (/\b(calendar|schedule|meeting|event|appointment|agenda|busy|free|availab)\b/.test(lower)) {
    const days = /\b(month)\b/.test(lower) ? 30 : /\b(week)\b/.test(lower) ? 7 : 7;
    const start = new Date().toISOString();
    const end = new Date(Date.now() + days * 86400000).toISOString();
    fetches.push(
      graphFetch(
        graphToken,
        `/me/calendarView?startDateTime=${start}&endDateTime=${end}&$select=subject,start,end,location,organizer,isOnlineMeeting&$orderby=start/dateTime&$top=25`
      ).then((data) => ({
        label: `Calendar events (next ${days} days)`,
        text: formatEvents(data as any),
      }))
    );
  }

  // OneDrive/Files detection
  if (/\b(file|document|onedrive|drive|folder|upload|download|sharepoint)\b/.test(lower)) {
    const folderMatch = lower.match(/(?:under|inside)\s+(?:the\s+)?(?:folder\s+)?["']?([a-z][\w\s]*[/\\][\w\s/\\-]*\w)["']?/i)
      || lower.match(/(?:in|from|at)\s+(?:the\s+)?folder\s+["']?([a-z][\w\s/\\-]*\w)["']?/i)
      || lower.match(/(?:in|from|at)\s+(?:the\s+)?["']?([a-z][\w\s]*[/\\][\w\s/\\-]*\w)["']?/i);
    let folderPath: string | null = null;
    if (folderMatch) {
      const candidate = folderMatch[1].trim().replace(/\\/g, "/").replace(/\s*\/\s*/g, "/");
      if (!/^(my\s+)?(onedrive|drive|sharepoint|the)\b/i.test(candidate)) {
        folderPath = candidate;
      }
    }

    const search = extractSearchTerm(lower, [
      "file", "files", "document", "documents", "onedrive", "drive",
      "folder", "folders", "upload", "download", "sharepoint",
      "find", "search", "list", "show", "my", "me", "the",
      "in", "on", "a", "an", "for", "recent", "latest",
      "check", "look", "what", "whats", "is", "are", "it",
      "under", "inside", "from", "at", "to", "of", "do",
      "have", "has", "get", "can", "could", "please", "help",
    ]);

    if (folderPath) {
      fetches.push(
        graphFetch(
          graphToken,
          `/me/drive/root:/${encodeURIComponent(folderPath).replace(/%2F/g, "/")}:/children?$select=name,size,lastModifiedDateTime,webUrl,folder&$top=50`
        ).then((data) => ({
          label: `Files in "${folderPath}"`,
          text: formatFiles(data as any),
        }))
      );
      if (search) {
        fetches.push(
          graphFetch(
            graphToken,
            `/me/drive/root:/${encodeURIComponent(folderPath).replace(/%2F/g, "/")}:/search(q='${encodeURIComponent(search)}')?$select=name,size,lastModifiedDateTime,webUrl&$top=15`
          ).then((data) => ({
            label: `Files matching "${search}" in "${folderPath}"`,
            text: formatFiles(data as any),
          }))
        );
      }
    } else if (search) {
      fetches.push(
        graphFetch(graphToken, `/me/drive/root/search(q='${encodeURIComponent(search)}')?$select=name,size,lastModifiedDateTime,webUrl&$top=15`).then((data) => ({
          label: `Files matching "${search}"`,
          text: formatFiles(data as any),
        }))
      );
    } else {
      fetches.push(
        graphFetch(graphToken, "/me/drive/recent?$select=name,size,lastModifiedDateTime,webUrl&$top=15").then((data) => ({
          label: "Recent files",
          text: formatFiles(data as any),
        }))
      );
    }
  }

  // Teams detection
  if (/\b(teams|chat|channel|team message)\b/.test(lower)) {
    fetches.push(
      graphFetch(
        graphToken,
        "/me/chats?$top=10&$expand=lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc"
      ).then((data) => ({
        label: "Recent Teams chats",
        text: formatChats(data as any),
      }))
    );
  }

  if (fetches.length === 0) {
    if (needsGraph) {
      return "\n\nIMPORTANT: The user seems to be asking about Microsoft 365 data but the request type couldn't be determined. Ask them to clarify what they need (emails, calendar, files, or Teams).";
    }
    return "";
  }

  const results = await Promise.all(fetches);
  const sections = results
    .filter((r): r is FetchResult => r !== null)
    .map((r) => `\n\n--- ${r.label} ---\n${r.text}`);

  if (sections.length === 0) return "";

  return `\n\nIMPORTANT: The following is REAL data fetched RIGHT NOW from the user's Microsoft 365 account via Graph API. You DO have real-time access. Present this data accurately — do not say you cannot access their data, do not fabricate data, and do not alter names, dates, or details. If the results are empty, say no results were found — do NOT say you lack access.${sections.join("")}`;
}

function extractSearchTerm(message: string, stopWords: string[]): string {
  const stopSet = new Set(stopWords);
  const words = message
    .replace(/[?!.,;:'"]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopSet.has(w));
  return words.join(" ").trim();
}
