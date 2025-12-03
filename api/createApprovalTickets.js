// /api/createApprovalTickets.js
// 議案DBのページID（pageId）を受け取り、
// 承認対象に応じて承認票DBに承認票を自動生成し、
// 生成した承認票ごとに LINE 承認依頼を送信する。

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

// 環境変数に DB ID があれば優先して使う（なければタイトル検索）
const MEMBER_DB_ID_ENV = process.env.NOTION_MEMBER_DATABASE_ID;   // 会員DB
const APPROVAL_DB_ID_ENV = process.env.NOTION_APPROVAL_DATABASE_ID; // 承認票DB

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

// DBタイトルからIDを検索（環境変数があればそちらを優先）
async function getDatabaseId(logicalName, fallbackTitle, envId) {
  if (envId) return envId;

  const data = await notionFetch("/search", {
    method: "POST",
    body: JSON.stringify({
      query: fallbackTitle,
      filter: { property: "object", value: "database" },
    }),
  });

  const hit = (data.results || []).find((db) => {
    const t = db.title?.[0]?.plain_text || "";
    return t === fallbackTitle;
  });

  if (!hit) {
    throw new Error(`Database "${logicalName}" not found (title="${fallbackTitle}")`);
  }

  return hit.id;
}

// 承認対象に応じて会員リストを取得
// ・理事会  : 会員DB.理事 = true かつ LINEユーザーID が空でない
// ・正会員: 会員DB.正会員 = true かつ LINEユーザーID が空でない
// ★開発中は「LINEユーザーID を安藤さんだけ埋めておく」ことで送信先を制御する。
async function getTargetMembers(approvalTarget) {
  const memberDbId = await getDatabaseId("会員DB", "会員DB", MEMBER_DB_ID_ENV);

  let roleFilter;
  if (approvalTarget === "理事会") {
    roleFilter = {
      property: "理事",
      checkbox: { equals: true },
    };
  } else if (approvalTarget === "正会員") {
    roleFilter = {
      property: "正会員",
      checkbox: { equals: true },
    };
  } else {
    throw new Error(`未知の承認対象: ${approvalTarget}`);
  }

  // LINEユーザーIDが入っている人だけを対象にする
  const filter = {
    and: [
      roleFilter,
      {
        property: "LINEユーザーID",
        rich_text: { is_not_empty: true },
      },
    ],
  };

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

  if (members.length === 0) {
    throw new Error(
      "承認対象の会員が見つかりません（該当ロールかつ LINEユーザーID が空でない会員が 0 件）"
    );
  }

  return members;
}

// 承認票DB に 1件作成
async function createApprovalTicket(approvalDbId, proposalPageId, proposalTitle, member) {
  const ticketTitle = `${proposalTitle}／${member.name}`;

  const body = {
    parent: { database_id: approvalDbId },
    properties: {
      // 承認票DB の Title プロパティ（「名前」で運用）
      名前: {
        title: [
          {
            text: { content: ticketTitle },
          },
        ],
      },
      // 会員（旧仕様）とのリレーション：互換のために残す
      会員: {
        relation: [{ id: member.id }],
      },
      // 新仕様：承認者リレーション（sendApprovalCore が参照する）
      承認者: {
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

// （オプション）議案ページに承認票を紐付けるリレーション
// 議案DB 側に「承認票DB」プロパティを作っている前提。
// なければこの処理は実害なくスキップしても良い。
async function attachTicketsToProposal(proposalPageId, ticketIds) {
  if (!ticketIds.length) return;

  const relations = ticketIds.map((id) => ({ id }));

  try {
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
  } catch (e) {
    // 関連プロパティが存在しない場合などは、ログだけ出して処理継続
    console.error("attachTicketsToProposal error (非致命的):", e.message || e);
  }
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

  // 2. 対象会員を取得（理事 or 正会員｜＋ LINEユーザーIDあり）
  const members = await getTargetMembers(approvalTarget);

  // 3. 承認票DB を特定
  const approvalDbId = await getDatabaseId("承認票DB", "承認票DB", APPROVAL_DB_ID_ENV);

  // 4. 承認票を人数分作成し、その場で LINE 承認依頼を送信
  const createdTicketIds = [];
  for (const member of members) {
    const ticketPage = await createApprovalTicket(
      approvalDbId,
      pageId,
      title,
      member
    );
    createdTicketIds.push(ticketPage.id);

    // 生成した承認票ごとに LINE 承認依頼を送信
    await sendApprovalMessage(ticketPage.id);
  }

  // 5. 議案ページ側に承認票を紐付け（あれば）
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
