// api/approve.js

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

async function updateApproval(pageId, resultName) {
  const now = new Date().toISOString();

  const body = {
    properties: {
      "承認結果": {
        select: { name: resultName } // "承認"
      },
      "承認日時": {
        date: { start: now }
      }
    }
  };

  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Notion API error:", res.status, text);
    throw new Error("Notion API error");
  }
}

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) {
    return res.status(400).send("id パラメータがありません。");
  }

  try {
    await updateApproval(id, "承認");
    res.status(200).send("承認として受け付けました。ありがとうございます。");
  } catch (e) {
    console.error(e);
    res.status(500).send("エラーが発生しました。");
  }
}
