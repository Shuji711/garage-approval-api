// /utils/sendApprovalCore.js

export async function sendApprovalMessage(pageId) {
  const notionToken = process.env.NOTION_API_KEY;
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const toIds = process.env.LINE_TO_IDS;

  if (!toIds) {
    return {
      ok: false,
      error: "No LINE recipient IDs configured (env LINE_TO_IDS)",
    };
  }

  const recipients = toIds.split(",");

  // --- 1. Notion からタイトル取得 ---
  const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
  });

  const pageData = await pageRes.json();
  const title =
    pageData.properties["タイトル"]?.title?.[0]?.plain_text || "承認依頼";

  // --- 2. 承認URL・否認URL を生成 ---
  const approveUrl = `https://approval.garagetsuno.org/approve?id=${pageId}`;
  const denyUrl = `https://approval.garagetsuno.org/deny?id=${pageId}`;

  // --- 3. Notion に URL を書き込む（承認URL／否認URL） ---
  await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        "承認URL": { url: approveUrl },
        "否認URL": { url: denyUrl },
      },
    }),
  });

  // --- 4. LINE メッセージ本文 ---
  const message = {
    type: "flex",
    altText: "承認依頼があります",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "承認依頼", weight: "bold", size: "lg" },
          { type: "text", text: title, wrap: true, margin: "md" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            action: { type: "uri", label: "承認する", uri: approveUrl },
            style: "primary",
          },
          {
            type: "button",
            action: { type: "uri", label: "否認する", uri: denyUrl },
            style: "secondary",
            margin: "md",
          },
        ],
      },
    },
  };

  // --- 5. LINE 送信 ---
  for (const id of recipients) {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lineToken}`,
      },
      body: JSON.stringify({
        to: id,
        messages: [message],
      }),
    });
  }

  return {
    ok: true,
    sentTo: recipients,
  };
}
