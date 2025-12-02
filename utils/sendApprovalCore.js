// /utils/sendApprovalCore.js

export async function sendApprovalMessage(pageId) {
  const notionToken = process.env.NOTION_API_KEY;
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const lineIds = (process.env.LINE_TO_IDS || "").split(",").map(id => id.trim()).filter(Boolean);

  if (!lineIds.length) {
    throw new Error("No LINE recipient IDs configured (env LINE_TO_IDS)");
  }
  if (!notionToken) {
    throw new Error("NOTION_API_KEY is not set");
  }
  if (!lineToken) {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not set");
  }

  // 1) Notionページを取得
  const notionRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
    },
  });

  const page = await notionRes.json();

  if (!notionRes.ok) {
    console.error("Notion API error:", page);
    throw new Error(`Notion API error: ${page.message || notionRes.statusText}`);
  }

  const props = page.properties || {};

  // 2) 案件名を安全に取得（プロパティ名の違いも許容）
  const titleProp = props["案件名"] || props["名前"] || props["Name"];
  let title = "案件名なし";

  if (titleProp?.title?.length) {
    title = titleProp.title[0].plain_text;
  } else if (titleProp?.rich_text?.length) {
    title = titleProp.rich_text[0].plain_text;
  }

  // 3) 承認／否認リンクは pageId から自動生成（Notion側プロパティに依存しない）
  const base = "https://garage-approval-api.vercel.app";
  const approveUrl = `${base}/api/approve?id=${pageId}`;
  const denyUrl = `${base}/api/deny?id=${pageId}`;

  // 4) 送信メッセージ（前にテストで使った形と同じイメージ）
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
          { type: "text", text: `案件名：${title}`, wrap: true, margin: "md" },
          { type: "text", text: "提出期限：未設定", size: "sm", color: "#666666", margin: "sm" },
          { type: "separator", margin: "md" },
          {
            type: "button",
            style: "primary",
            color: "#00b900",
            margin: "md",
            action: { type: "uri", label: "承認する", uri: approveUrl },
          },
          {
            type: "button",
            style: "secondary",
            color: "#aaaaaa",
            margin: "sm",
            action: { type: "uri", label: "否認する", uri: denyUrl },
          },
          {
            type: "text",
            text: "※承認結果は自動で記録されます。",
            size: "xs",
            color: "#999999",
            margin: "md",
          },
        ],
      },
    },
  };

  // 5) LINE へ送信
  const results = [];

  for (const userId of lineIds) {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lineToken}`,
      },
      body: JSON.stringify({
        to: userId,
        messages: [message],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("LINE API error:", res.status, body);
      throw new Error(`LINE API error: ${res.status}`);
    }

    results.push(userId);
  }

  return { ok: true, sentTo: results };
}
