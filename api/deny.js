// /api/deny.js
// 否認処理：承認票DBに「否認」と日時だけ記録する

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

async function notionFetch(path, options = {}) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Notion API error ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

export default async function handler(req, res) {
  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ status: "error", message: "Missing id" });
    }

    const pageId = id;
    const now = new Date().toISOString();

    // 承認票DBの「承認結果」「承認日時」だけを更新
    await notionFetch(`pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          承認結果: { select: { name: "否認" } },
          承認日時: { date: { start: now } },
        },
      }),
    });

    return res.status(200).json({ status: "ok" });
  } catch (e) {
    console.error("deny error:", e);
    return res.status(500).json({ status: "error", message: e.message });
  }
}
