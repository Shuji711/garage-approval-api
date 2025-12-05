// /api/createApprovalTickets.js
// 議案から承認票を 1枚だけ upsert して LINE 承認依頼を送る

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

const APPROVAL_DB_ID = process.env.NOTION_APPROVAL_DB_ID;
const APPROVAL_DB_TITLE_PROP =
  process.env.NOTION_APPROVAL_DB_TITLE_PROP || "名前";

// 共通 Notion リクエスト
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

// sendApprovalCore を動的 import
async function sendLineApproval(approvalPageId) {
  const mod = await import("../utils/sendApprovalCore.js");
  if (!mod || !mod.sendApprovalMessage) {
    throw new Error("sendApprovalMessage is not exported from sendApprovalCore.js");
  }
  return mod.sendApprovalMessage(approvalPageId);
}

// 議案ページ取得
async function fetchProposal(pageId) {
  return notionRequest(`/pages/${pageId}`, "GET");
}

// 承認票を 1枚だけ upsert
// - 既に「承認票」リレーションがあればそれを再利用
// - 無ければ承認票DBに 1枚作成して、議案側の「承認票」リレーションも張る
async function upsertApprovalTicketForProposal(proposalPage) {
  const proposalId = proposalPage.id;
  const props = proposalPage.properties || {};

  // 議案タイトル（承認票タイトルに使う）
  let proposalTitle = "";
  const titleProp = props["議案"];
  if (titleProp && titleProp.type === "title" && titleProp.title.length) {
    proposalTitle = titleProp.title.map((t) => t.plain_text).join("");
  }

  // 1. 既存の承認票があればそれを再利用
  let approvalPageId = null;
  const approvalRelationProp = props["承認票"];
  if (
    approvalRelationProp &&
    approvalRelationProp.type === "relation" &&
    approvalRelationProp.relation &&
    approvalRelationProp.relation.length > 0
  ) {
    approvalPageId = approvalRelationProp.relation[0].id;
  }

  // 2. 無ければ承認票を新規作成
  if (!approvalPageId) {
    if (!APPROVAL_DB_ID) {
      throw new Error("NOTION_APPROVAL_DB_ID is not set. Cannot create approval ticket.");
    }

    const titleText =
      proposalTitle && proposalTitle.trim().length > 0
        ? `【承認票】${proposalTitle.trim()}`
        : "承認票";

    const newPage = await notionRequest("/pages", "POST", {
      parent: { database_id: APPROVAL_DB_ID },
      properties: {
        // 承認票DBのタイトルプロパティ
        [APPROVAL_DB_TITLE_PROP]: {
          title: [
            {
              type: "text",
              text: { content: titleText },
            },
          ],
        },
        // 議案とのリレーション
        議案: {
          relation: [{ id: proposalId }],
        },
      },
    });

    approvalPageId = newPage.id;

    // 議案側にも「承認票」リレーションを書き戻す
    await notionRequest(`/pages/${proposalId}`, "PATCH", {
      properties: {
        承認票: {
          relation: [{ id: approvalPageId }],
        },
      },
    });
  } else {
    // 既存承認票側に「議案」リレーションが無ければ張っておく（保険）
    try {
      const approvalPage = await notionRequest(`/pages/${approvalPageId}`, "GET");
      const aProps = approvalPage.properties || {};
      const rel = aProps["議案"];
      const alreadyLinked =
        rel &&
        rel.type === "relation" &&
        Array.isArray(rel.relation) &&
        rel.relation.some((r) => r.id === proposalId);

      if (!alreadyLinked) {
        await notionRequest(`/pages/${approvalPageId}`, "PATCH", {
          properties: {
            議案: {
              relation: [{ id: proposalId }],
            },
          },
        });
      }
    } catch (e) {
      console.error("Failed to ensure 議案 relation on existing approval page:", e);
    }
  }

  return approvalPageId;
}

// 承認票のステータスをリセット（差戻し→再送信用）
// - 承認結果: null
// - 承認日時: null
// - コメント: 空
async function resetApprovalStatus(approvalPageId) {
  const properties = {
    承認結果: {
      select: null,
    },
    承認日時: {
      date: null,
    },
    コメント: {
      rich_text: [],
    },
  };

  await notionRequest(`/pages/${approvalPageId}`, "PATCH", { properties });
}

// 議案のステータスを「承認待ち」にする（あれば）
async function updateProposalStatusToWaiting(pageId) {
  try {
    await notionRequest(`/pages/${pageId}`, "PATCH", {
      properties: {
        ステータス: {
          select: { name: "承認待ち" },
        },
      },
    });
  } catch (e) {
    // ステータスプロパティが無い場合などは致命的ではないのでログだけ
    console.warn("Failed to update proposal status to 承認待ち:", e.message || e);
  }
}

// --------- エントリーポイント ---------

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET");
      res.end("Method Not Allowed");
      return;
    }

    const url = new URL(req.url, `https://${req.headers.host}`);
    const pageId = url.searchParams.get("pageId") || url.searchParams.get("id");

    if (!pageId) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: "pageId is required" }));
      return;
    }

    // 1. 議案ページ取得
    const proposalPage = await fetchProposal(pageId);

    // 2. 承認票を upsert（既存があれば再利用、無ければ新規）
    const approvalPageId = await upsertApprovalTicketForProposal(proposalPage);

    // 3. 承認票のステータスをリセット（再送信でも常にクリーンな状態から）
    await resetApprovalStatus(approvalPageId);

    // 4. 議案ステータスを「承認待ち」に更新（あれば）
    await updateProposalStatusToWaiting(pageId);

    // 5. LINE へ承認依頼送信
    const result = await sendLineApproval(approvalPageId);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: true,
        proposalPageId: pageId,
        approvalPageId,
        lineResult: result,
      })
    );
  } catch (err) {
    console.error("createApprovalTickets error:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: false,
        error: err.message || String(err),
      })
    );
  }
};
