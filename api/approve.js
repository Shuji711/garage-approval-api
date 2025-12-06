// /api/approve.js
// 承認処理 ＋ 承認後に議案DBの状況を自動更新（可決判定）する

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

async function notionFetch(path, options = {}) {
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
    throw new Error(`Notion API error ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

// --- 議案ステータス自動更新（承認用） -------------------------
async function updateProposalStatus(proposalId) {
  const proposalPage = await notionFetch(`pages/${proposalId}`);

  const props = proposalPage.properties || {};

  // ロールアップ値の取得
  const approveCount = props["理事承認数"]?.rollup?.number ?? 0;
  const directorCount = props["理事数"]?.rollup?.number ?? 0;
  const minashi = props["みなし決議"]?.formula?.string ?? "";

  let statusToSet = null;

  // みなし決議優先
  if (minashi === "成立") {
    statusToSet = "可決";
  } else {
    // 過半数判定
    const majority = Math.floor(directorCount / 2) + 1;
    if (approveCount >= majority) statusToSet = "可決";
  }

  if (!statusToSet) return; // 可決条件に未達 → 何もしない

  // セレクト「状況」を更新
  await notionFetch(`pages/${proposalId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        状況: {
          select: { name: statusToSet }
        }
      }
    })
  });
}

// --- Main handler ---------------------------------------------------------
export default async function handler(req, res) {
  try {
    const { id } = req.query;     // 承認票ID
    if (!id) {
      return res.status(400).json({ status: "error", message: "Missing id" });
    }

    const pageId = id;

    // 1) 承認票に承認を記録
    const now = new Date().toISOString();
    await notionFetch(`pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          承認結果: { select: { name: "承認" } },
          承認日時: { date: { start: now } }
        }
      })
    });

    // 2) 承認票 → 議案リレーションを取得
    const ticket = await notionFetch(`pages/${pageId}`);
    const rel = ticket.properties?.["議案"]?.relation || [];
    const proposalId = rel[0]?.id;

    if (proposalId) {
      // 3) 議案のロールアップを元に自動ステータス更新
      await updateProposalStatus(proposalId);
    }

    return res.status(200).json({ status: "ok" });
  } catch (e) {
    console.error("approve error:", e);
    return res.status(500).json({ status: "error", message: e.message });
  }
}
