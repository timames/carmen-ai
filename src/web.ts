/**
 * Web search and URL fetching for Carmen AI.
 * Uses Brave Search API (free tier: 2000 queries/month).
 */

// ── URL content extraction ──────────────────────────

async function fetchUrl(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,text/plain",
    },
    redirect: "follow",
  });

  if (!res.ok) return `[Error fetching ${url}: HTTP ${res.status}]`;

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const json = await res.text();
    return json.slice(0, 30_000);
  }

  const html = await res.text();
  return htmlToText(html).slice(0, 30_000);
}

function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "");
  text = text.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n## $1\n");
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<td[^>]*>([\s\S]*?)<\/td>/gi, "$1\t");
  text = text.replace(/<tr[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

// ── Brave Search API ────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchBrave(
  query: string,
  apiKey: string
): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!res.ok) {
    console.error(`Brave Search error: HTTP ${res.status}`);
    return [];
  }

  const data = (await res.json()) as {
    web?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
      }>;
    };
  };

  return (data.web?.results || []).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.description || "",
  }));
}

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "No search results found.";
  return results
    .map(
      (r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`
    )
    .join("\n\n");
}

// ── Detection and dispatch ──────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

export async function fetchWebContext(
  message: string,
  braveApiKey?: string
): Promise<string> {
  const lower = message.toLowerCase();
  const sections: string[] = [];

  // Extract and fetch any URLs in the message
  const urls = message.match(URL_REGEX) || [];
  for (const url of urls.slice(0, 3)) {
    try {
      const content = await fetchUrl(url);
      sections.push(`\n\n--- Content from ${url} ---\n${content}`);
    } catch (err) {
      sections.push(`\n\n--- Error fetching ${url}: ${err} ---`);
    }
  }

  // Detect search intent (only if no URLs were provided)
  if (urls.length === 0 && braveApiKey) {
    const needsSearch =
      /\b(search|google|look\s*up|internet|web|online|current|latest|recent|news|price|weather|stock|status|update|release|version|today|yesterday|last\s+week|last\s+month|this\s+week|this\s+month|this\s+year|right\s+now|happening|happened|going\s+on)\b/i.test(
        lower
      ) ||
      /\b(what|who|when|where|how|tell\s+me)\b.*\b(in\s+\d{4}|june|july|august|september|october|november|december|january|february|march|april|may)\s+\d{4}\b/i.test(
        lower
      ) ||
      /\bwhat\s+(?:is|are|was|were|happened|is\s+happening)\b/i.test(lower);

    if (needsSearch) {
      let query = "";
      const searchPatterns = [
        /(?:search|google|look\s*up|find\s+(?:info|information|out)|research)\s+(?:for\s+|about\s+)?(?:"|')?(.+?)(?:"|')?$/i,
        /(?:what\s+is|what\s+are|who\s+is|how\s+(?:to|do|does)|when\s+(?:is|was|did)|where\s+(?:is|are))\s+(.+?)$/i,
        /(?:check|look\s+(?:up|into)|search)\s+(?:the\s+)?(?:internet|web|online)\s+(?:for\s+)?(.+?)$/i,
      ];

      for (const pattern of searchPatterns) {
        const m = message.match(pattern);
        if (m) {
          query = m[1].trim();
          break;
        }
      }

      if (!query) {
        query = message
          .replace(/^(can you |please |hey |carmen |could you )/i, "")
          .replace(
            /^(search|google|look up|find)\s+(for\s+|about\s+)?/i,
            ""
          )
          .trim();
      }

      if (query.length > 3) {
        try {
          const results = await searchBrave(query, braveApiKey);
          if (results.length > 0) {
            sections.push(
              `\n\n--- Web search results for "${query}" ---\n${formatSearchResults(results)}`
            );

            // Auto-fetch the top result for more detail
            try {
              const topContent = await fetchUrl(results[0].url);
              const truncated = topContent.slice(0, 15_000);
              sections.push(
                `\n\n--- Top result content (${results[0].title}) ---\n${truncated}`
              );
            } catch {
              // Skip if top result fetch fails
            }
          }
        } catch (err) {
          sections.push(`\n\n--- Web search error: ${err} ---`);
        }
      }
    }
  }

  if (sections.length === 0) return "";

  return `\n\nThe following REAL data was fetched from the internet just now. Present it accurately and cite sources when possible.${sections.join("")}`;
}
