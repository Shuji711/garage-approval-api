// /api/createApprovalTickets.js

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

// 既存の環境変数名に合わせる
const NOTION_MEMBER_DB_ID = process.env.NOTION_MEMBER_DB_ID;     // 会員DB
const NOTION_APPROVAL_DB_ID = process.env.NOTION_APPROVAL_DB_ID; // 承認票DB

async function notionFetch(path, options = {}) {
  if (!NOTION_API_KEY) throw new Error("NOTION_API_KEY が未設定です。");

  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`Notion API error [${path}] ${res.status}: ${text}`);
    throw new Error(`Notion API error ${res.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function fetchPage(pageId) {
  return notionFetch(`pages/${pageId}`, { method: "GET" });
}

function extractText(prop) {
  if (!prop) return "";
  if (Array.isArray(prop.title) && prop.title.length > 0) {
    return prop.title.map((t) => t.plain_text || "").join("");
  }
  if (Array.isArray(prop.rich_text) && prop.rich_text.length > 0) {
    return prop.rich_text.map((t) => t.plain_text || "").join("");
  }
  if (typeof prop.plain_text === "string") return prop.plain_text;
  return "";
}

function getAgendaTitle(page) {
  const props = page.properties || {};
  const titleProp =
    props["議案"] ||
    props["名前"] ||
    props["タイトル"];
  const title = extractText(titleProp).trim();
  return title || "無題議案";
}

async function fetchDirectors() {
  if (!NOTION_MEMBER_DB_ID) {
    throw new Error("NOTION_MEMBER_DB_ID が未設定です。");
  }

  const body = {
    filter: {
      and: [
        { property: "理事", checkbox: { equals: true } },
        { property: "承認システム利用ステータス", select: { equals: "本番" } },
        { property: "LINE承認有効", checkbox: { equals: true } }
      ]
    },
    page_size: 100
  };

  const data = await notionFetch(
    `databases/${NOTION_MEMBER_DB_ID}/query`,
    { method: "POST", body: JSON.stringify(body) }
  );

  return data.results || [];
}

async function existsTicketFor(agendaId, memberId) {
  if (!NOTION_APPROVAL_DB_ID) {
    throw new Error("NOTION_APPROVAL_DB_ID が未設定です。");
  }

  const body = {
    filter: {
      and: [
        { property: "議案", relation: { contains: agendaId } },
        { property: "会員", relation: { contains: memberId } }
      ]
    },
    page_size: 1
  };

  const data = await notionFetch(
    `databases/${NOTION_APPROVAL_DB_ID}/query`,
    { method: "POST", body: JSON.stringify(body) }
  );

  return (data.results || []).length > 0;
}

async function createTicket({ agendaId, agendaTitle, memberId, memberName }) {
  if (!NOTION_APPROVAL_DB_ID) {
    throw new Error("NOTION_APPROVAL_DB_ID が未設定です。");
  }

  const title = `${agendaTitle} / ${memberName}`;

  const body = {
    parent: { database_id: NOTION_APPROVAL_DB_ID },
    properties: {
      名前: {
        title: [{ type: "text", text: { content: title } }]
      },
      議案: { relation: [{ id: agendaId }] },
      会員: { relation: [{ id: memberId }] }
      // 他プロパティは触らない
    }
  };

  await notionFetch("pages", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

function parseBody(req) {
  return typeof req.body === "string"
    ? JSON.parse(req.body || "{}")
    : (req.body || {});
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ status: "error", message: "Method Not Allowed" });
  }

  try {
    if (!NOTION_MEMBER_DB_ID || !NOTION_APPROVAL_DB_ID) {
      return res.status(500).json({
        status: "error",
        message: "NOTION_MEMBER_DB_ID / NOTION_APPROVAL_DB_ID が未設定です。"
      });
    }

    const body = parseBody(req);
    const agendaId = body.agendaId || body.pageId || body.page_id;

    if (!agendaId) {
      return res.status(400).json({
        status: "error",
        message: "agendaId / pageId / page_id のいずれかが必須です。"
      });
    }

    const agendaPage = await fetchPage(agendaId);
    const agendaTitle = getAgendaTitle(agendaPage);

    const directors = await fetchDirectors();
    if (!directors || directors.length === 0) {
      return res.status(400).json({
        status: "error",
        message: "条件に合致する理事が会員DBから取得できませんでした。"
      });
    }

    let created = 0;
    let skipped = 0;

    for (const member of directors) {
      const memberId = member.id;
      const mProps = member.properties || {};

      const nameProp = mProps["氏名"] || mProps["名前"] || mProps["フルネーム"];
      const memberName = (extractText(nameProp) || "").trim() || "氏名不明";

      const already = await existsTicketFor(agendaId, memberId);
      if (already) {
        skipped += 1;
        continue;
      }

      await createTicket({ agendaId, agendaTitle, memberId, memberName });
      created += 1;
    }

    return res.status(200).json({
      status: "ok",
      agendaId,
      created,
      skipped
    });
  } catch (err) {
    console.error("createApprovalTickets error:", err);
    return res.status(500).json({
      status: "error",
      message: err.message || "Internal Server Error"
    });
  }
};
