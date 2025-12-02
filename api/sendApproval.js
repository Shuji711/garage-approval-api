// api/sendApproval.js
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";
const LINE_TOKEN = process.env.LINE_TOKEN;

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const pageId = searchParams.get("pageId");

  if (!pageId) {
    return new Response("Missing pageId", { status: 400 });
  }

  // Notion からデータ取得（承認票DB）
  const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
    },
  });

  if (!pageRes.ok) {
    const text = await pageRes.text();
    return new Response(text, { status: pageRes.status });
  }

  const pageData = await pageRes.json();

  // LINEユーザーID を取得（会員DBからリレーション取得済みを想定）
  const lineUserId =
    pageData.properties["LINEユーザーID"]?.rich_text?.[0]?.plain_text;

  if (!lineUserId) {
    return new Response("LINEユーザーID not found", { status: 400 });
  }

  // 承認・否認リンク生成
  const approveUrl = `https://approval.garagetsuno.org/approve?id=${pageId}`;
  const denyUrl = `https://approval.garagetsuno.org/deny?id=${pageId}`;

  // LINEへ送るメッセージ
  const message = {
    to: lineUserId,
    messages: [
      {
        type: "text",
        text:
          "承認依頼が届いています。\n\n" +
          "【承認】\n" + approveUrl + "\n\n" +
          "【否認】\n" + denyUrl,
      },
    ],
  };

  // LINE Messaging API へ送信
  const lineRes = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify(message),
  });

  if (!lineRes.ok) {
    const text = await lineRes.text();
    return new Response(text, { status: lineRes.status });
  }

  return new Response("Sent");
}
