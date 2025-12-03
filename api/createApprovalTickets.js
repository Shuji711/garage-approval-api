// /api/createApprovalTickets.js
// 議案DBのページID（pageId）を受け取り、
// 承認対象に応じて承認票DBに承認票を自動生成し、
// 生成した承認票ごとに LINE 承認依頼を送信する。
// ※現在はテスト段階として「安藤 修二」のみを送信対象とする。

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

const { sendApprovalMessage } = require("../utils/sendApprovalCore");

// 共通 Notion fetch
async function notionFetch(path, options = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API error [${path}]: ${res.status} ${text}`);
  }

  return res.json();
}

// タイトルから DB を検索（会員DB / 承認票DB 用）
async function findDatabaseIdByTitle(title) {
  const data = await notionFetch("/search", {
    method: "POST",
    body: JSON.stringify({
      query: title,
      filter: { property: "object", value: "database" },
    }),
  });

  const hit = (data.results || []).find((db) => {
    const t = db.title?.[0]?.plain_text || "";
    return t === title;
  });

  if (!hit) {
    throw new Error(`Database "${title}" not found`);
  }

  return hit.id;
}

// 承認対象に応じて会員リストを取得
async function getTargetMembers(approvalTarget) {
  // 会員DB をタイトルから取得
  const memberDbId = await findDatabaseIdByTitle("会員DB");

  let filter;
  if (approvalTarget === "理事会") {
    // 会員DB.理事 = true
    filter = {
      property: "理事",
      checkbox: { equals: true },
    };
  } else if (approvalTarget === "正会員") {
    // 会員DB.正会員 = true
    filter = {
      property: "正会員",
      checkbox: { equals: true },
    };
  } else {
    throw new Error(`未知の承認対象: ${approvalTarget}`);
  }

  const data = await notionFetch(`/databases/${memberDbId}/query`, {
    method: "POST",
    body: JSON.stringify({ filter }),
  });

  const members = (data.results || []).map((page) => {
    const name =
      page.properties["氏名"]?.title?.[0]?.plain_text ||
      page.properties["名前"]?.title?.[0]?.plain_text ||
      "（名称不明）";
    return {
      id: page.id,
      name,
    };
  });

  // ★テスト段階：安藤 修二 だけに絞る
  const filtered = members.filter((m) => m.name === "安藤 修二");

  if (filtered.length === 0) {
    throw new Error("テスト対象（安藤 修二）が会員DBから見つかりません。");
  }

  return filtered;
}

// 承認票DB に 1件作成
async function createApprovalTicket(approvalDbId, proposalPageId, proposalTitle, member) {
  const ticketTitle = `${proposalTitle}／${member.name}`;

  const body = {
    parent: { database_id: approvalDbId },
    properties: {
      // 承認票DB の Title プロパティ（名前 or タイトル）
      名前: {
        title: [
          {
            text: { content: ticketTitle },
          },
        ],
      },
      // 会員リレーション
      会員: {
        relation: [{ id: member.id }],
      },
      // 議案リレーション
      議案: {
        relation: [{ id: proposalPageId }],
      },
    },
  };

  const page = await notionFetch("/pages", {
    method: "POST",
    body: JSON.stringify(body),
  });

  return page;
}

// 議案ページに承認票を紐付ける（承認票DB リレーション）
async function attachTicketsToProposal(proposalPageId, ticketIds) {
  if (!ticketIds.length) return;

  const relations = ticketIds.map((id) => ({ id }));

  await notionFetch(`/pages/${proposalPageId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        承認票DB: {
          relation: relations,
        },
      },
    }),
  });
}

// メイン処理
async function handleCreateTickets(pageId) {
  // 1. 議案ページ取得
  const proposal = await notionFetch(`/pages/${pageId}`);

  const props = proposal.properties || {};

  const title =
    props["議案"]?.title?.[0]?.plain_text ||
    props["名前"]?.title?.[0]?.plain_text ||
    "無題議案";

  const approvalTarget = props["承認対象"]?.select?.name;

  if (!approvalTarget) {
    throw new Error("議案の「承認対象」が選択されていません。");
  }

  // 2. 対象会員を取得（理事 or 正会員）
  const members = await getTargetMembers(approvalTarget);

  // 3. 承認票DB を特定
  const approvalDbId = await findDatabaseIdByTitle("承認票DB");

  // 4. 承認票を人数分作成
  const createdTicketIds = [];
  for (const member of members) {
    const ticketPage = await createApprovalTicket(
      approvalDbId,
      pageId,
      title,
      member
    );
    createdTicketIds.push(ticketPage.id);

    // 5. 生成した承認票ごとに LINE 承認依頼を送信
    await sendApprovalMessage(ticketPage.id);
  }

  // 6. 議案ページ側に承認票を紐付け
  await attachTicketsToProposal(pageId, createdTicketIds);

  return {
    ok: true,
    target: approvalTarget,
    members,
    tickets: createdTicketIds,
  };
}

// Vercel ハンドラ
module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      status: "error",
      message: "Method not allowed",
    });
  }

  const pageId = req.query.pageId;

  if (!pageId) {
    return res.status(400).json({
      status: "error",
      message: "Missing pageId",
    });
  }

  try {
    const result = await handleCreateTickets(pageId);
    return res.status(200).json({
      status: "ok",
      result,
    });
  } catch (e) {
    console.error("createApprovalTickets error:", e);
    return res.status(500).json({
      status: "error",
      message: e.message || "Internal server error",
    });
  }
};
