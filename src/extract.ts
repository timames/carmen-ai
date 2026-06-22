/**
 * Document text extraction for uploaded files.
 * Supports PDF, DOCX, XLSX, PPTX, and images.
 */

import { extractText } from "unpdf";
import { unzipSync, strFromU8 } from "fflate";

// ── PDF ─────────────────────────────────────────────

export async function extractPdf(data: ArrayBuffer): Promise<string> {
  const { text } = await extractText(data);
  return text;
}

// ── DOCX ────────────────────────────────────────────

export function extractDocx(data: ArrayBuffer): string {
  const files = unzipSync(new Uint8Array(data));
  const docXml = files["word/document.xml"];
  if (!docXml) return "[Could not read DOCX content]";
  return stripXmlTags(strFromU8(docXml));
}

// ── XLSX ────────────────────────────────────────────

export function extractXlsx(data: ArrayBuffer): string {
  const files = unzipSync(new Uint8Array(data));

  const sharedStrings: string[] = [];
  const ssXml = files["xl/sharedStrings.xml"];
  if (ssXml) {
    const ssText = strFromU8(ssXml);
    const matches = ssText.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g);
    for (const m of matches) {
      sharedStrings.push(m[1]);
    }
  }

  const output: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith("xl/worksheets/sheet") || !path.endsWith(".xml")) continue;
    const sheetName = path.replace("xl/worksheets/", "").replace(".xml", "");
    const xml = strFromU8(content as Uint8Array);
    const rows: string[] = [];

    const rowMatches = xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g);
    for (const rowMatch of rowMatches) {
      const cells: string[] = [];
      const cellMatches = rowMatch[1].matchAll(/<c[^>]*(?:t="([^"]*)")?[^>]*>[\s\S]*?<v>([\s\S]*?)<\/v>[\s\S]*?<\/c>/g);
      for (const cm of cellMatches) {
        const type = cm[1];
        const val = cm[2];
        if (type === "s") {
          cells.push(sharedStrings[parseInt(val)] || val);
        } else {
          cells.push(val);
        }
      }
      if (cells.length > 0) rows.push(cells.join("\t"));
    }

    if (rows.length > 0) {
      output.push(`--- ${sheetName} ---\n${rows.join("\n")}`);
    }
  }

  return output.join("\n\n") || "[Empty spreadsheet]";
}

// ── PPTX ────────────────────────────────────────────

export function extractPptx(data: ArrayBuffer): string {
  const files = unzipSync(new Uint8Array(data));
  const slides: string[] = [];

  const slidePaths = Object.keys(files)
    .filter((p) => p.startsWith("ppt/slides/slide") && p.endsWith(".xml"))
    .sort();

  for (const path of slidePaths) {
    const xml = strFromU8(files[path]);
    const text = stripXmlTags(xml).trim();
    if (text) {
      const slideNum = path.match(/slide(\d+)/)?.[1] || "?";
      slides.push(`--- Slide ${slideNum} ---\n${text}`);
    }
  }

  return slides.join("\n\n") || "[Empty presentation]";
}

// ── Image (via Workers AI vision) ───────────────────

export async function extractImage(
  data: ArrayBuffer,
  fileName: string,
  ai: Ai
): Promise<string> {
  const base64 = arrayBufferToBase64(data);
  const ext = fileName.split(".").pop()?.toLowerCase() || "png";
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  };
  const mime = mimeMap[ext] || "image/png";

  const result = await ai.run("@cf/meta/llama-3.2-11b-vision-instruct" as any, {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image in detail. If it contains text, tables, forms, or diagrams, extract all visible text and data." },
          { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      },
    ],
    max_tokens: 2048,
  }) as { response?: string };

  return result.response || "[Could not describe image]";
}

// ── Dispatcher ──────────────────────────────────────

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif"]);

export async function extractFileContent(
  data: ArrayBuffer,
  fileName: string,
  fileType: string,
  ai: Ai
): Promise<string | null> {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";

  try {
    if (fileType === "application/pdf" || ext === "pdf") {
      return await extractPdf(data);
    }
    if (ext === "docx" || fileType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      return extractDocx(data);
    }
    if (ext === "xlsx" || fileType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      return extractXlsx(data);
    }
    if (ext === "pptx" || fileType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
      return extractPptx(data);
    }
    if (IMAGE_EXTS.has(ext) || fileType.startsWith("image/")) {
      return await extractImage(data, fileName, ai);
    }
  } catch (err) {
    return `[Error extracting ${fileName}: ${err}]`;
  }

  return null;
}

// ── Helpers ─────────────────────────────────────────

function stripXmlTags(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
