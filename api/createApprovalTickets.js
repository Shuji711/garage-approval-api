// /api/createApprovalTickets.js
// 議案1件に対して「理事全員分の承認票」を自動生成するAPI
// ・Notion Automations の Webhook から呼び出す想定（POST）
// ・既に同じ 議案 + 会員 の組み合わせの承認票がある場合はスキップ（重複発行防止）
// ・設定／更新するプロパティは「議案」「会員」「名前」の3つだけ
//   → 承認結果・URL・フラグ類は他API(sendApproval/approve/deny等)の責務とする

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

// 環境変数（★Vercel側で要設定）
// 会員DB（会員DB）の ID
const NOTION_MEMBER_DATABASE_ID = process.env.NOTION_MEMBER_DATABASE_ID;
// 承認票DB の ID
const NOTION_TICKET_DATABASE_ID = process.env.NOTION_TICKET_DATABASE_ID;

/** 共通 Notion fetch ラッパー */
async function notionFetch(path, options = {}) {
  if (!NOTION_API_KEY) {
    throw new Error("NOTION_API_KEY が未設定です。");
  }

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

/** ページ1件取得 */
async function fetchPage(pageId) {
  return notionFetch(`pages/${pageId}`, { method: "GET" });
}

/** title / rich_text からテキストを取り出す簡易ヘルパー（日本語プロパティ名対応） */
function extractText(prop) {
  if (!prop) return "";

  if (Array.isArray(prop.title) && prop.title.length > 0) {
    return prop.title.map((t) => t.plain_text || "").join("");
  }

  if (Array.isArray(prop.rich_text) && prop.rich_text.length > 0) {
    return prop.rich_text.map((t) => t.plain_text || "").join("");
  }

  if (typeof prop.plain_text === "string") {
    return prop.plain_text;
  }

  return "";
}

/** 議案ページから「表示用タイトル」を取得 */
function getAgendaTitle(page) {
  const props = page.properties || {};
  // 優先：議案 → 名前 → タイトル
  const titleProp =
    props["議案"] ||
    props["名前"] ||
    props["タイトル"];

  const title = extractText(titleProp).trim();
  return title || "無題議案";
}

/** 会員DBから「理事かつ本番かつLINE承認有効」な会員を抽出 */
async function fetchDirectors() {
  if (!NOTION_MEMBER_DATABASE_ID) {
    throw new Error("NOTION_MEMBER_DATABASE_ID が未設定です。");
  }

  const body = {
    filter: {
      and: [
        {
          property: "理事",
          checkbox: { equals: true }
        },
        {
          property: "承認システム利用ステータス",
          select: { equals: "本番" }
        },
        {
          property: "LINE承認有効",
          checkbox: { equals: true }
        }
      ]
    },
    page_size: 100
  };

  const data = await notionFetch(
    `databases/${NOTION_MEMBER_DATABASE_ID}/query`,
    {
      method: "POST",
      body: JSON.stringify(body)
    }
  );

  return data.results || [];
}

/** 同じ議案 + 同じ会員 の承認票が既にあるかチェック */
async function existsTicketFor(agendaId, memberId) {
  if (!NOTION_TICKET_DATABASE_ID) {
    throw new Error("NOTION_TICKET_DATABASE_ID が未設定です。");
  }

  const body = {
    filter: {
      and: [
        {
          property: "議案",
          relation: { contains: agendaId }
        },
        {
          property: "会員",
          relation: { contains: memberId }
        }
      ]
    },
    page_size: 1
  };

  const data = await notionFetch(
    `databases/${NOTION_TICKET_DATABASE_ID}/query`,
    {
      method: "POST",
      body: JSON.stringify(body)
    }
  );

  return (data.results || []).length > 0;
}

/** 承認票1件を新規作成（議案・会員・名前のみ設定） */
async function createTicket({ agendaId, agendaTitle, memberId, memberName }) {
  if (!NOTION_TICKET_DATABASE_ID) {
    throw new Error("NOTION_TICKET_DATABASE_ID が未設定です。");
  }

  const title = `${agendaTitle} / ${memberName}`;

  const body = {
    parent: { database_id: NOTION_TICKET_DATABASE_ID },
    properties: {
      名前: {
        title: [
          {
            type: "text",
            text: { content: title }
          }
        ]
      },
      議案: {
        relation: [{ id: agendaId }]
      },
      会員: {
        relation: [{ id: memberId }]
      }
      // ★ 他のプロパティ（承認結果・URL・フラグ等）は一切触らない
    }
  };

  await notionFetch("pages", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

/** リクエストボディを安全にパース（Notion Automations からの JSON 文字列も考慮） */
function parseBody(req) {
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  return body;
}

/** メインハンドラ */
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res
      .status(405)
      .json({ status: "error", message: "Method Not Allowed" });
  }

  try {
    if (!NOTION_API_KEY) {
      return res.status(500).json({
        status: "error",
        message: "NOTION_API_KEY が未設定です。"
      });
    }

    if (!NOTION_MEMBER_DATABASE_ID || !NOTION_TICKET_DATABASE_ID) {
      return res.status(500).json({
        status: "error",
        message:
          "NOTION_MEMBER_DATABASE_ID / NOTION_TICKET_DATABASE_ID のいずれかが未設定です。"
      });
    }

    const body = parseBody(req);

    // Notion Automations からは pageId or page_id を渡す想定
    const agendaId = body.pageId || body.page_id || body.agendaId;

    if (!agendaId) {
      return res.status(400).json({
        status: "error",
        message: "agendaId / pageId / page_id のいずれかが必須です。"
      });
    }

    // 1) 議案ページ取得＆タイトル抽出
    const agendaPage = await fetchPage(agendaId);
    const agendaTitle = getAgendaTitle(agendaPage);

    // 2) 会員DBから理事一覧を取得
    const directors = await fetchDirectors();

    if (!directors || directors.length === 0) {
      return res.status(400).json({
        status: "error",
        message: "条件に合致する理事が会員DBから取得できませんでした。"
      });
    }

    let created = 0;
    let skipped = 0;

    // 3) 各理事ごとに承認票を生成（既存があればスキップ）
    for (const member of directors) {
      const memberId = member.id;
      const mProps = member.properties || {};

      const nameProp =
        mProps["氏名"] ||
        mProps["名前"] ||
        mProps["フルネーム"];

      const memberName = (extractText(nameProp) || "").trim() || "氏名不明";

      const already = await existsTicketFor(agendaId, memberId);
      if (already) {
        skipped += 1;
        continue;
      }

      await createTicket({
        agendaId,
        agendaTitle,
        memberId,
        memberName
      });

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
