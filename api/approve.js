// api/approve.js
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

async function updateApproval(pageId, resultName) {
  const now = new Date().toISOString();

  const body = {
    properties: {
      // セレクトプロパティ「承認結果」に "承認" / "否認" を入れる
      "承認結果": {
        select: { name: resultName },
      },
      // 日付プロパティ「承認日時」に実行時刻を入れる
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

    await updateApproval(id, "承認");

    return res
      .status(200)
      .send("承認として受け付けました。ご対応ありがとうございます。");
  } catch (e) {
    console.error(e);
    return res.status(500).send("エラーが発生しました。");
  }
}

await notion.pages.update({
  page_id: pageId,
  properties: {
    "承認結果": { select: { name: "承認" } },
    "承認日": { date: { start: new Date().toISOString() } },
    "送信ステータス": { select: { name: "送信済" } }
  }
});
