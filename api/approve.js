// api/approve.js

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

async function updateApproval(pageId, resultName) {
  const now = new Date().toISOString();

  const body = {
    properties: {
      // セレクトプロパティ「承認結果」に "承認" / "否認" を入れる
      承認結果: {
        select: { name: resultName },
      },
      // 日付プロパティ「承認日時」に実行時刻を入れる
      承認日時: {
        date: { start: now },
      },
    },
  };

  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API error: ${res.status} ${text}`);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).send("Method not allowed");
  }

  const pageId = req.query.id; // URL の ?id=... を受け取る

  if (!pageId) {
    return res.status(400).send("Missing id");
  }

  try {
    await updateApproval(pageId, "承認");
    return res.status(200).send("OK");
  } catch (e) {
    console.error("approve error:", e);
    return res.status(500).send(e.message || "Internal server error");
  }
};
