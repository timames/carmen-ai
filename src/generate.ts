/**
 * Document generation — creates DOCX, XLSX, PPTX from markdown content.
 * Uses fflate to build OOXML ZIP archives directly in Workers.
 */

import { zipSync, strToU8 } from "fflate";

// ── Normalize HTML/Markdown to clean markdown ───────

function normalizeToMarkdown(input: string): string {
  let text = input;

  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, c) => `# ${stripHtml(c).trim()}\n`);
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, c) => `## ${stripHtml(c).trim()}\n`);
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, c) => `### ${stripHtml(c).trim()}\n`);
  text = text.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, (_, c) => `### ${stripHtml(c).trim()}\n`);

  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `- ${stripHtml(c).trim()}\n`);
  text = text.replace(/<\/?[uo]l[^>]*>/gi, "\n");

  text = text.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
    const cells: string[] = [];
    const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let m;
    while ((m = cellRegex.exec(row)) !== null) {
      cells.push(stripHtml(m[1]).trim());
    }
    if (cells.length === 0) return "";
    if (cells.length === 2 && cells[0]) return `**${cells[0]}** ${cells[1]}\n`;
    return cells.join("\t") + "\n";
  });
  text = text.replace(/<\/?table[^>]*>/gi, "\n");

  text = text.replace(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, "**$1**");
  text = text.replace(/<(?:i|em)[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, "*$1*");

  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, c) => `${stripHtml(c).trim()}\n\n`);
  text = text.replace(/<br\s*\/?>/gi, "\n");

  text = text.replace(/<[^>]+>/g, "");

  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));

  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// ── Markdown parsing helpers ────────────────────────

interface ParsedLine {
  type: "h1" | "h2" | "h3" | "p" | "li" | "table-row" | "blank";
  text: string;
  cells?: string[];
}

function parseMarkdownLines(input: string): ParsedLine[] {
  const md = normalizeToMarkdown(input);
  const lines: ParsedLine[] = [];
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed.startsWith("### ")) {
      lines.push({ type: "h3", text: trimmed.slice(4) });
    } else if (trimmed.startsWith("## ")) {
      lines.push({ type: "h2", text: trimmed.slice(3) });
    } else if (trimmed.startsWith("# ")) {
      lines.push({ type: "h1", text: trimmed.slice(2) });
    } else if (/^\s*[-*+]\s/.test(line)) {
      lines.push({ type: "li", text: trimmed.replace(/^[-*+]\s+/, "") });
    } else if (/^\s*\d+\.\s/.test(line)) {
      lines.push({ type: "li", text: trimmed.replace(/^\d+\.\s+/, "") });
    } else if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      if (/^\|[\s\-:|]+\|$/.test(trimmed)) continue;
      const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
      lines.push({ type: "table-row", text: "", cells });
    } else if (trimmed === "") {
      lines.push({ type: "blank", text: "" });
    } else {
      lines.push({ type: "p", text: trimmed });
    }
  }
  return lines;
}

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textToRuns(text: string): string {
  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const boldMatch = remaining.match(/\*\*(.+?)\*\*|__(.+?)__/);
    if (boldMatch && boldMatch.index !== undefined) {
      if (boldMatch.index > 0) {
        parts.push(`<w:r><w:t xml:space="preserve">${escXml(remaining.slice(0, boldMatch.index))}</w:t></w:r>`);
      }
      const boldText = boldMatch[1] || boldMatch[2];
      parts.push(`<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escXml(boldText)}</w:t></w:r>`);
      remaining = remaining.slice(boldMatch.index + boldMatch[0].length);
      continue;
    }
    parts.push(`<w:r><w:t xml:space="preserve">${escXml(remaining)}</w:t></w:r>`);
    break;
  }

  return parts.join("");
}

// ── DOCX Generation ─────────────────────────────────

function generateDocx(markdown: string): Uint8Array {
  const lines = parseMarkdownLines(markdown);

  const elements: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.type === "blank") { i++; continue; }

    if (l.type === "table-row") {
      const tableRows: string[][] = [];
      while (i < lines.length && lines[i].type === "table-row") {
        tableRows.push(lines[i].cells || []);
        i++;
      }
      const maxCols = Math.max(...tableRows.map((r) => r.length));
      const colWidth = Math.floor(9000 / maxCols);

      const rows = tableRows.map((cells, ri) => {
        const tcs = [];
        for (let ci = 0; ci < maxCols; ci++) {
          const cellText = cells[ci] || "";
          const bold = ri === 0;
          const runs = bold
            ? `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escXml(cellText.replace(/\*\*/g, ""))}</w:t></w:r>`
            : textToRuns(cellText);
          tcs.push(`<w:tc><w:tcPr><w:tcW w:w="${colWidth}" w:type="dxa"/>${ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>' : ''}</w:tcPr><w:p>${runs}</w:p></w:tc>`);
        }
        return `<w:tr>${tcs.join("")}</w:tr>`;
      });

      elements.push(`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr><w:tblGrid>${'<w:gridCol w:w="' + colWidth + '"/>'.repeat(maxCols)}</w:tblGrid>${rows.join("")}</w:tbl>`);
      continue;
    }

    let style = "";
    let runs = "";
    switch (l.type) {
      case "h1":
        style = '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>';
        runs = textToRuns(l.text);
        break;
      case "h2":
        style = '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>';
        runs = textToRuns(l.text);
        break;
      case "h3":
        style = '<w:pPr><w:pStyle w:val="Heading3"/></w:pPr>';
        runs = textToRuns(l.text);
        break;
      case "li":
        style = '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>';
        runs = `<w:r><w:t xml:space="preserve">-  </w:t></w:r>${textToRuns(l.text)}`;
        break;
      default:
        runs = textToRuns(l.text);
    }
    elements.push(`<w:p>${style}${runs}</w:p>`);
    i++;
  }

  const paragraphs = elements.join("\n");

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
${paragraphs}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:pPr><w:spacing w:before="200" w:after="80"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:pPr><w:spacing w:before="160" w:after="60"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
</w:styles>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rels),
    "word/document.xml": strToU8(documentXml),
    "word/styles.xml": strToU8(stylesXml),
    "word/_rels/document.xml.rels": strToU8(docRels),
  });
}

// ── XLSX Generation ─────────────────────────────────

function generateXlsx(rawInput: string): Uint8Array {
  const markdown = normalizeToMarkdown(rawInput);
  const rows: string[][] = [];
  const lines = markdown.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("|")) {
      if (/^\|[\s\-:|]+\|$/.test(trimmed)) continue;
      const cells = trimmed
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim().replace(/\*\*/g, ""));
      rows.push(cells);
      continue;
    }

    if (trimmed.startsWith("#")) {
      rows.push([trimmed.replace(/^#+\s*/, "")]);
      continue;
    }

    if (/^[-*]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      rows.push([trimmed.replace(/^[-*]\s+|^\d+\.\s+/, "")]);
      continue;
    }

    const kvMatch = trimmed.match(/^\*\*(.+?)\*\*[:\s]+(.*)$/);
    if (kvMatch) {
      rows.push([kvMatch[1], kvMatch[2].replace(/_+/g, "").trim() || ""]);
      continue;
    }

    rows.push([trimmed.replace(/\*\*/g, "")]);
  }

  if (rows.length === 0) rows.push(["(empty)"]);

  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  for (const row of rows) {
    for (const cell of row) {
      if (!stringIndex.has(cell)) {
        stringIndex.set(cell, strings.length);
        strings.push(cell);
      }
    }
  }

  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${rows.reduce((a, r) => a + r.length, 0)}" uniqueCount="${strings.length}">
${strings.map((s) => `<si><t>${escXml(s)}</t></si>`).join("\n")}
</sst>`;

  const colLetter = (i: number) => String.fromCharCode(65 + i);
  const sheetRows = rows
    .map((row, ri) => {
      const cells = row
        .map((cell, ci) => {
          const ref = `${colLetter(ci)}${ri + 1}`;
          const idx = stringIndex.get(cell)!;
          return `<c r="${ref}" t="s"><v>${idx}</v></c>`;
        })
        .join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("\n");

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
${sheetRows}
  </sheetData>
</worksheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sheet1" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rels),
    "xl/workbook.xml": strToU8(workbookXml),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml),
    "xl/sharedStrings.xml": strToU8(sharedStringsXml),
    "xl/_rels/workbook.xml.rels": strToU8(wbRels),
  });
}

// ── PPTX Generation ─────────────────────────────────

function generatePptx(rawInput: string): Uint8Array {
  const markdown = normalizeToMarkdown(rawInput);
  const sections: { title: string; body: string[] }[] = [];
  let current: { title: string; body: string[] } = { title: "", body: [] };

  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (/^#{1,2}\s/.test(trimmed)) {
      if (current.title || current.body.length > 0) {
        sections.push(current);
      }
      current = { title: trimmed.replace(/^#+\s*/, ""), body: [] };
    } else if (trimmed) {
      const clean = trimmed
        .replace(/^[-*]\s+/, "\u2022 ")
        .replace(/^\d+\.\s+/, "\u2022 ")
        .replace(/\*\*/g, "");
      current.body.push(clean);
    }
  }
  if (current.title || current.body.length > 0) {
    sections.push(current);
  }

  if (sections.length === 0) {
    sections.push({ title: "Slide 1", body: [markdown.slice(0, 500)] });
  }

  const slideWidth = 12192000;
  const slideHeight = 6858000;

  const slideXmls: Record<string, Uint8Array> = {};
  const slideRels: Record<string, Uint8Array> = {};
  const slideOverrides: string[] = [];
  const slideRelEntries: string[] = [];

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const n = i + 1;
    const bodyText = s.body.map((b) =>
      `<a:p><a:r><a:rPr lang="en-US" sz="1800" dirty="0"/><a:t>${escXml(b)}</a:t></a:r></a:p>`
    ).join("\n");

    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:p><a:r><a:rPr lang="en-US" sz="3200" b="1" dirty="0"/><a:t>${escXml(s.title)}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="4525963"/></a:xfrm>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/>
          ${bodyText || '<a:p><a:endParaRPr lang="en-US"/>'}
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`;

    slideXmls[`ppt/slides/slide${n}.xml`] = strToU8(slideXml);
    slideRels[`ppt/slides/_rels/slide${n}.xml.rels`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`
    );
    slideOverrides.push(
      `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    );
    slideRelEntries.push(
      `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/>`
    );
  }

  const presentationXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
                xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst>
  <p:sldIdLst>
${sections.map((_, i) => `    <p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("\n")}
  </p:sldIdLst>
  <p:sldSz cx="${slideWidth}" cy="${slideHeight}"/>
  <p:notesSz cx="${slideHeight}" cy="${slideWidth}"/>
</p:presentation>`;

  const slideMasterXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
             xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
             xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`;

  const slideLayoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
             xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
             xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
</p:sldLayout>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
${slideOverrides.join("\n")}
</Types>`;

  const presRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${slideRelEntries.join("\n")}
  <Relationship Id="rIdMaster" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
</Relationships>`;

  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`),
    "ppt/presentation.xml": strToU8(presentationXml),
    "ppt/_rels/presentation.xml.rels": strToU8(presRels),
    "ppt/slideMasters/slideMaster1.xml": strToU8(slideMasterXml),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`),
    "ppt/slideLayouts/slideLayout1.xml": strToU8(slideLayoutXml),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`),
    ...slideXmls,
    ...slideRels,
  });
}

// ── Public API ───────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  md: "text/markdown",
};

export function generateDocument(
  content: string,
  format: string
): { data: Uint8Array | string; mimeType: string } {
  const fmt = format.toLowerCase();

  if (fmt === "md") {
    return { data: content, mimeType: "text/markdown" };
  }

  if (fmt === "docx") {
    return { data: generateDocx(content), mimeType: MIME_TYPES.docx };
  }

  if (fmt === "xlsx") {
    return { data: generateXlsx(content), mimeType: MIME_TYPES.xlsx };
  }

  if (fmt === "pptx") {
    return { data: generatePptx(content), mimeType: MIME_TYPES.pptx };
  }

  throw new Error(`Unsupported format: ${format}`);
}

export const SUPPORTED_FORMATS = Object.keys(MIME_TYPES);
