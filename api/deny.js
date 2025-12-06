// /api/deny.js
// 否認処理 ＋ 議案DBの状況を自動更新（否決判定）

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

// --- 議案ステータス自動更新（否決用） -------------------------
async function updateProposalStatus(proposalId) {
  const proposalPage = await notionFetch(`pages/${proposalId}`);
  const props = proposalPage.properties || {};

  const directorCount = props["理事数"]?.rollup?.number ?? 0;
  const approveCount = props["理事承認数"]?.rollup?.number ?? 0;
  const denyCount = props["反対数"]?.number ?? 0;  // 反対数が保持されている想定
  const minashi = props["みなし決議"]?.formula?.string ?? "";

  let statusToSet = null;

  // 否決条件：
  // 1. みなし決議が「不成立」
  if (minashi === "不成立") {
    statusToSet = "否決";
  }

  // 2. 反対多数または承認が過半数未満で全回答済み
  const majority = Math.floor(directorCount / 2) + 1;
  if (approveCount < majority && denyCount >= directorCount - approveCount) {
    statusToSet = "否決";
  }

  if (!statusToSet) return;

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
    const { id } = req.query;   // 承認票ID
    if (!id) {
      return res.status(400).json({ status: "error", message: "Missing id" });
    }

    const pageId = id;
    const now = new Date().toISOString();

    // 1) 否認を記録
    await notionFetch(`pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          承認結果: { select: { name: "否認" } },
          承認日時: { date: { start: now } }
        }
      })
    });

    // 2) 承認票 → 議案リレーション
    const ticket = await notionFetch(`pages/${pageId}`);
    const rel = ticket.properties?.["議案"]?.relation || [];
    const proposalId = rel[0]?.id;

    if (proposalId) {
      // 3) 自動ステータス更新
      await updateProposalStatus(proposalId);
    }

    return res.status(200).json({ status: "ok" });
  } catch (e) {
    console.error("deny error:", e);
    return res.status(500).json({ status: "error", message: e.message });
  }
}
