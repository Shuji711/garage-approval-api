// /utils/sendApprovalCore.js
import fetch from 'node-fetch';

export async function sendApprovalMessage(pageId) {
  const notionToken = process.env.NOTION_API_KEY;
  const lineIds = (process.env.LINE_TO_IDS || "").split(",");

  if (!lineIds.length || !lineIds[0]) {
    throw new Error("No LINE recipient IDs configured (env LINE_TO_IDS)");
  }

  // Notionからデータ取得
  const notion = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
    },
  }).then(r => r.json());

  const title = notion.properties["案件名"]?.title?.[0]?.plain_text || "案件名なし";
  const approveUrl = notion.properties["承認リンク"]?.url || "";
  const denyUrl = notion.properties["否認リンク"]?.url || "";

  // LINE送信用メッセージ作成
  const message = {
    type: "flex",
    altText: "【承認のお願い】",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "【承認のお願い】", weight: "bold", size: "lg" },
          { type: "text", text: `案件名：${title}`, wrap: true },
          { type: "separator", margin: "md" },
          {
            type: "button",
            style: "primary",
            action: { type: "uri", label: "承認する", uri: approveUrl }
          },
          {
            type: "button",
            style: "secondary",
            action: { type: "uri", label: "否認する", uri: denyUrl }
          }
        ]
      }
    }
  };

  // LINE へ送信
  for (const userId of lineIds) {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({ to: userId, messages: [message] })
    });
  }

  return { ok: true, sentTo: lineIds };
}
