// /api/createApprovalTickets.js

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

// 会員DB（NOTION_MEMBER_DB_ID）と承認票DB（NOTION_APPROVAL_DB_ID）のIDは
// Vercel の環境変数に設定しておく
const MEMBER_DB_ID = process.env.NOTION_MEMBER_DB_ID;
const APPROVAL_DB_ID = process.env.NOTION_APPROVAL_DB_ID;

// 共通 Notion 呼び出し
async function notionRequest(path, method = "GET", body) {
  if (!NOTION_API_KEY) {
    throw new Error("NOTION_API_KEY is not set.");
  }

  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Notion API error:", res.status, text);
    throw new Error(`Notion API error: ${res.status}`);
  }

  return res.json();
}

// 議案ページから 承認対象（理事会/正会員） を取得
async function getApprovalTargetFromAgenda(pageId) {
  const page = await notionRequest(`/pages/${pageId}`, "GET");
  const props = page.properties;

  const targetProp = props["承認対象"];
  if (!targetProp || targetProp.type !== "select" || !targetProp.select) {
    throw new Error("議案ページの「承認対象」プロパティが設定されていません。");
  }

  const name = targetProp.select.name || "";
  if (name !== "理事会" && name !== "正会員") {
    throw new Error(`承認対象が不正です: ${name}`);
  }

  return name; // "理事会" or "正会員"
}

// 会員DBから、承認対象に応じた「本番」対象会員を取得
async function getTargetMembers(targetName) {
  if (!MEMBER_DB_ID) {
    throw new Error("NOTION_MEMBER_DB_ID is not set.");
  }

  // 承認対象に応じて見る役職プロパティを切り替え
  const rolePropName = targetName === "理事会" ? "理事" : "正会員";

  const body = {
    filter: {
      and: [
        {
          property: rolePropName,
          checkbox: {
            equals: true,
          },
        },
        {
          property: "承認システム利用ステータス",
          select: {
            equals: "本番",
          },
        },
      ],
    },
    page_size: 100,
  };

  const result = await notionRequest(`/databases/${MEMBER_DB_ID}/query`, "POST", body);
  return result.results || [];
}

// 既に同じ「議案×会員」の承認票があるか確認
async function hasExistingApprovalTicket(agendaPageId, memberPageId) {
  if (!APPROVAL_DB_ID) {
    throw new Error("NOTION_APPROVAL_DB_ID is not set.");
  }

  const body = {
    filter: {
      and: [
        {
          property: "議案",
          relation: {
            contains: agendaPageId,
          },
        },
        {
          property: "会員",
          relation: {
            contains: memberPageId,
          },
        },
      ],
    },
    page_size: 1,
  };

  const result = await notionRequest(`/databases/${APPROVAL_DB_ID}/query`, "POST", body);
  return (result.results || []).length > 0;
}

// 承認票DBに 1 行作成
async function createApprovalTicket(agendaPageId, memberPageId) {
  if (!APPROVAL_DB_ID) {
    throw new Error("NOTION_APPROVAL_DB_ID is not set.");
  }

  const body = {
    parent: {
      database_id: APPROVAL_DB_ID,
    },
    properties: {
      // 議案DBへのリレーション
      "議案": {
        relation: [{ id: agendaPageId }],
      },
      // 会員DBへのリレーション
      "会員": {
        relation: [{ id: memberPageId }],
      },
      // 承認結果／承認日時は空で作成（approve.js で更新）
      // 必要に応じて他の初期値を足してもよい
    },
  };

  const page = await notionRequest("/pages", "POST", body);
  return page;
}

// メイン API ハンドラ
export default async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      res.status(405).json({ status: "error", message: "Method not allowed" });
      return;
    }

    const pageId = (req.query.pageId || req.body?.pageId || "").toString();
    if (!pageId) {
      res.status(400).json({ status: "error", message: "pageId is required" });
      return;
    }

    // 1. 議案の承認対象を取得
    const targetName = await getApprovalTargetFromAgenda(pageId);

    // 2. 会員DBから対象会員を取得（理事会 or 正会員 × 本番）
    const members = await getTargetMembers(targetName);

    if (!members.length) {
      res.status(200).json({
        status: "ok",
        message: "対象会員が見つかりません（本番の会員が0件）",
        createdCount: 0,
      });
      return;
    }

    const createdTickets = [];
    const skippedMembers = [];

    // 3. 各会員ごとに承認票が既にあるか確認し、なければ作成
    for (const memberPage of members) {
      const memberId = memberPage.id;

      const exists = await hasExistingApprovalTicket(pageId, memberId);
      if (exists) {
        skippedMembers.push(memberId);
        continue;
      }

      const ticket = await createApprovalTicket(pageId, memberId);
      createdTickets.push(ticket.id);
    }

    res.status(200).json({
      status: "ok",
      target: targetName,
      memberCount: members.length,
      createdCount: createdTickets.length,
      createdTickets,
      skippedMembers,
    });
  } catch (err) {
    console.error("createApprovalTickets error:", err);
    res.status(500).json({
      status: "error",
      message: err.message || "Unexpected error",
    });
  }
}
