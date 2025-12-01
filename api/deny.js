// api/deny.js
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

async function updateApproval(pageId, resultName) {
  const now = new Date().toISOString();

  const body = {
    properties: {
      "承認結果": {
        select: { name: resultName }, // "否認"
      },
      "承認日時": {
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
    console.error("Notion API error:", res.status, text);
    throw new Error("Notion API error");
  }
}

export default async function handler(req, res) {
  try {
    const id = req.query.id;
    if (!id) {
      return res
        .status(400)
        .send("id パラメータがありません。（承認票の id() を渡してください）");
    }

    await updateApproval(id, "否認");

    return res.status(200).send("否認として受け付けました。ご確認ありがとうございます。");
  } catch (e) {
    console.error(e);
    return res.status(500).send("エラーが発生しました。");
  }
}
