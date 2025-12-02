// api/deny.js
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
    return new Response(text, { status: res.status });
  }

  return new Response("OK");
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const pageId = searchParams.get("id");

  if (!pageId) {
    return new Response("Missing id", { status: 400 });
  }

  // 否認
  return updateApproval(pageId, "否認");
}
