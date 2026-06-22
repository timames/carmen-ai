/**
 * NinjaOne RMM integration for Carmen AI.
 * OAuth2 authorization code flow + API data fetching.
 * Restricted to allowed users only.
 */

const NINJA_BASE = "https://cardinalservicesltd.rmmservices.net";
const NINJA_SCOPES = "monitoring management control";
const ALLOWED_EMAILS = ["rosal.jeffrey@cardinalservicesltd.com", "tames@cardinalservicesltd.com", "malia@cardinalservicesltd.com"];

export function isNinjaAllowed(email: string): boolean {
  return ALLOWED_EMAILS.includes(email.toLowerCase());
}

// ── OAuth flow ──────────────────────────────────────

export function getNinjaLoginUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: NINJA_SCOPES,
    state,
  });
  return `${NINJA_BASE}/ws/oauth/authorize?${params}`;
}

export async function exchangeNinjaCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<NinjaTokens | null> {
  const res = await fetch(`${NINJA_BASE}/ws/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    console.error("NinjaOne token exchange failed:", await res.text());
    return null;
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || "",
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export async function refreshNinjaToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<NinjaTokens | null> {
  const res = await fetch(`${NINJA_BASE}/ws/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) return null;

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

interface NinjaTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

// ── Token storage (KV) ─────────────────────────────

export async function getNinjaToken(
  kv: KVNamespace,
  userId: string,
  clientId: string,
  clientSecret: string
): Promise<string | null> {
  const data = await kv.get(`ninja:${userId}`);
  if (!data) return null;

  const tokens: NinjaTokens = JSON.parse(data);

  // Still valid (5 min buffer)
  if (Date.now() < tokens.expiresAt - 300_000) {
    return tokens.accessToken;
  }

  // Try refresh
  if (!tokens.refreshToken) return null;
  const refreshed = await refreshNinjaToken(tokens.refreshToken, clientId, clientSecret);
  if (!refreshed) return null;

  await kv.put(`ninja:${userId}`, JSON.stringify(refreshed), { expirationTtl: 86400 * 30 });
  return refreshed.accessToken;
}

export async function storeNinjaToken(
  kv: KVNamespace,
  userId: string,
  tokens: NinjaTokens
): Promise<void> {
  await kv.put(`ninja:${userId}`, JSON.stringify(tokens), { expirationTtl: 86400 * 30 });
}

// ── API fetching ────────────────────────────────────

async function ninjaFetch(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${NINJA_BASE}/v2${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { error: `NinjaOne API ${res.status}` };
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeEntries(obj: any): string {
  if (!obj || typeof obj !== "object") return "";
  return Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => {
      if (typeof v === "object") return `  ${k}: ${JSON.stringify(v)}`;
      return `  ${k}: ${v}`;
    })
    .join("\n");
}

function formatDeviceDetail(data: Record<string, unknown> | { error?: string }): string {
  if ("error" in data) return `Error fetching device: ${data.error}. DO NOT fabricate device details.`;

  const d = data as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(`**Device: ${d.systemName || d.dnsName || "Unknown"}**`);
  lines.push(`ID: ${d.id || "N/A"}`);
  lines.push(`Type: ${d.nodeClass || "N/A"}`);

  const os = d.os as Record<string, unknown> | undefined;
  if (os) lines.push(`OS: ${os.name || "N/A"}`);

  const sys = d.system as Record<string, unknown> | undefined;
  if (sys) {
    if (sys.manufacturer) lines.push(`Manufacturer: ${sys.manufacturer}`);
    if (sys.model) lines.push(`Model: ${sys.model}`);
    if (sys.biosSerialNumber) lines.push(`Serial: ${sys.biosSerialNumber}`);
  }

  const proc = d.processors as Record<string, unknown>[] | undefined;
  if (proc?.length) lines.push(`Processor: ${proc.map((p) => p.name || "Unknown").join(", ")}`);

  if (d.memory) {
    const memGB = (d.memory as Record<string, unknown>).installedRam;
    if (memGB) lines.push(`RAM: ${memGB}`);
  }

  if (d.lastContact) lines.push(`Last Contact: ${new Date(d.lastContact as string).toLocaleString("en-US")}`);
  if (d.ipAddresses) lines.push(`IP: ${d.ipAddresses}`);

  const lastUser = d.lastLoggedInUser as string | undefined;
  if (lastUser) lines.push(`Last Logged In User: ${lastUser}`);

  const refs = d.references as Record<string, unknown> | undefined;
  if (refs?.organization) {
    const org = refs.organization as Record<string, unknown>;
    if (org.name) lines.push(`Organization: ${org.name}`);
  }

  const handled = new Set(["id", "systemName", "dnsName", "nodeClass", "os", "system", "processors", "memory", "lastContact", "ipAddresses", "lastLoggedInUser", "references"]);
  for (const [k, v] of Object.entries(d)) {
    if (handled.has(k) || v === null || v === undefined || v === "") continue;
    if (typeof v === "object") {
      const s = safeEntries(v);
      if (s) lines.push(`${k}:\n${s}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }

  return lines.join("\n");
}

function formatDevices(data: Record<string, unknown>[] | { error?: string }): string {
  if ("error" in data) return `Error fetching devices: ${(data as { error: string }).error}. DO NOT fabricate device data.`;
  const devices = data as Record<string, unknown>[];
  if (!devices.length) return "No devices found. DO NOT fabricate device data.";

  return devices.slice(0, 30).map((d, i) => {
    const lastSeen = d.lastContact ? new Date(d.lastContact as string).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }) : "Unknown";
    const refs = d.references as Record<string, unknown> | undefined;
    const org = (refs?.organization as Record<string, unknown>)?.name || "";
    const os = (d.os as Record<string, unknown>)?.name || "";
    return `${i + 1}. **${d.systemName || d.dnsName || "Unknown"}** (${d.nodeClass || "device"}) — ${os}${org ? ` — ${org}` : ""} — Last seen: ${lastSeen}`;
  }).join("\n");
}

function formatAlerts(data: Record<string, unknown>[] | { error?: string }): string {
  if ("error" in data) return `Error fetching alerts: ${(data as { error: string }).error}. DO NOT fabricate alerts.`;
  const alerts = data as Record<string, unknown>[];
  if (!alerts.length) return "No active alerts. DO NOT fabricate alert data.";

  return alerts.slice(0, 20).map((a, i) => {
    const time = a.createTime ? new Date((a.createTime as number) * 1000).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }) : "";
    const device = (a.device as Record<string, unknown>)?.systemName || `Device #${a.deviceId}`;
    return `${i + 1}. [${((a.severity as string) || "INFO").toUpperCase()}] **${device}** — ${a.message || "No details"} (${time})`;
  }).join("\n");
}

function formatOrgs(data: Record<string, unknown>[] | { error?: string }): string {
  if ("error" in data) return `Error fetching organizations: ${(data as { error: string }).error}. DO NOT fabricate organization data.`;
  const orgs = data as Record<string, unknown>[];
  if (!orgs.length) return "No organizations found. DO NOT fabricate organization data.";

  return orgs.map((o, i) =>
    `${i + 1}. **${o.name || "Unknown"}** — ${o.nodeCount ?? "unknown"} devices`
  ).join("\n");
}

// ── Helpers ──────────────────────────────────────────

function toArray(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && "results" in (data as Record<string, unknown>)) {
    const r = (data as Record<string, unknown>).results;
    if (Array.isArray(r)) return r;
  }
  return [];
}

function extractDeviceName(message: string): string | null {
  const matches = message.matchAll(/\b([A-Z]{2,}[-_]?\d[\w-]*)\b/gi);
  for (const match of matches) {
    return match[1].toUpperCase();
  }
  const hyphenated = message.matchAll(/\b([A-Z]{2,}-[A-Z0-9][\w-]*)\b/gi);
  for (const match of hyphenated) {
    return match[1].toUpperCase();
  }
  return null;
}

// ── Context builder ─────────────────────────────────

export async function fetchNinjaContext(
  message: string,
  ninjaToken: string | null
): Promise<string> {
  if (!ninjaToken) return "";

  const lower = message.toLowerCase();
  const needsNinja = /\b(ninja|ninjaone|rmm|device|endpoint|computer|server|workstation|laptop|machine|agent|alert|patch|install|antivirus|disk|cpu|memory|ram|uptime|offline|online|managed|org|organization|client|group|fetch|retrieve|inventory|how\s+many|count)\b/.test(lower);

  const deviceName = extractDeviceName(message);
  if (!needsNinja && !deviceName) return "";

  const fetches: Promise<{ label: string; text: string }>[] = [];

  if (deviceName) {
    fetches.push(
      ninjaFetch(ninjaToken, "/devices?pageSize=200").then(async (data) => {
        const devices = toArray(data);
        const match = devices.find((d) => {
          const name = ((d.systemName || d.dnsName || "") as string).toUpperCase();
          return name === deviceName || name.includes(deviceName);
        });
        if (match) {
          const detail = await ninjaFetch(ninjaToken, `/device/${match.id}`);
          return {
            label: `NinjaOne Device Detail: ${deviceName}`,
            text: formatDeviceDetail(detail as any),
          };
        }
        return {
          label: `NinjaOne Device Search: ${deviceName}`,
          text: `No device found matching "${deviceName}". DO NOT fabricate device details — tell the user the device was not found.`,
        };
      })
    );
  }

  if (/\b(alert|warning|critical|issue|problem|error|fail|down|offline)\b/.test(lower)) {
    fetches.push(
      ninjaFetch(ninjaToken, "/alerts?pageSize=20&sourceType=CONDITION").then((data) => ({
        label: "Active NinjaOne Alerts",
        text: formatAlerts(toArray(data)),
      }))
    );
  }

  const wantsDeviceList = /\b(device|endpoint|computer|server|workstation|laptop|machine|agent|managed|online|offline|inventory|fetch|retrieve|list|how\s+many|count)\b/.test(lower);
  if (!deviceName && wantsDeviceList) {
    fetches.push(
      (async () => {
        const allDevices = toArray(await ninjaFetch(ninjaToken, "/devices?pageSize=200"));

        const orgMatch = lower.match(/\b(?:in|at|for|from|group|site|location)\s+["']?(\w[\w\s]*\w)["']?/i);
        if (orgMatch) {
          const orgQuery = orgMatch[1].toUpperCase();
          const filtered = allDevices.filter((d) => {
            const refs = d.references as Record<string, unknown> | undefined;
            const orgName = ((refs?.organization as Record<string, unknown>)?.name as string || "").toUpperCase();
            return orgName.includes(orgQuery);
          });
          return {
            label: `NinjaOne Devices in "${orgMatch[1]}" (${filtered.length} of ${allDevices.length} total)`,
            text: filtered.length > 0
              ? formatDevices(filtered)
              : `No devices found in group/org "${orgMatch[1]}". Total devices: ${allDevices.length}. DO NOT fabricate device data.`,
          };
        }

        return {
          label: `NinjaOne Managed Devices (${allDevices.length} total)`,
          text: formatDevices(allDevices),
        };
      })()
    );
  }

  if (/\b(org|organization|client|tenant|company|group|site|location)\b/.test(lower)) {
    fetches.push(
      ninjaFetch(ninjaToken, "/organizations").then((data) => ({
        label: "NinjaOne Organizations",
        text: formatOrgs(toArray(data)),
      }))
    );
  }

  if (fetches.length === 0) {
    fetches.push(
      ninjaFetch(ninjaToken, "/alerts?pageSize=10&sourceType=CONDITION").then((data) => ({
        label: "Active NinjaOne Alerts",
        text: formatAlerts(toArray(data)),
      })),
      ninjaFetch(ninjaToken, "/devices?pageSize=200").then((data) => {
        const devices = toArray(data);
        return {
          label: `NinjaOne Managed Devices (${devices.length} total)`,
          text: formatDevices(devices),
        };
      })
    );
  }

  const results = await Promise.all(fetches);
  const sections = results.map((r) => `\n\n--- ${r.label} ---\n${r.text}`);

  return `\n\nIMPORTANT: The following is REAL data fetched RIGHT NOW from NinjaOne RMM. Present ONLY what is shown here — do NOT fabricate device names, users, IP addresses, specs, alerts, or organizations. If a field is not present in the data, say it is not available — NEVER guess or make up values.${sections.join("")}`;
}
