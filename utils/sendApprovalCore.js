// /utils/sendApprovalCore.js

export async function sendApprovalMessage(pageId) {
  const notionToken = process.env.NOTION_API_KEY;
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  // --- 1. Notion からページ詳細を取得 ---
  const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
  });

  const pageData = await pageRes.json();

  // --- 2. タイトルを取得 ---
  const title =
    pageData.properties["タイトル"]?.title?.[0]?.plain_text || "承認依頼";

  // --- 3. 承認者（リレーション）から 会員DB のページID を取得 ---
  const approverRelation =
    pageData.properties["承認者"]?.relation || [];

  if (approverRelation.length === 0) {
    return { ok: false, error: "承認者が設定されていません。" };
  }

  // --- 4. 会員DBの各ページから LINEユーザーID を取得 ---
  const lineUserIds = [];

  for (const person of approverRelation) {
    const memberId = person.id;

    // 会員DBのページを取得
    const memberRes = await fetch(
      `https://api.notion.com/v1/pages/${memberId}`,
      {
        headers: {
          Authorization: `Bearer ${notionToken}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
      }
    );

    const memberData = await memberRes.json();
    const lineId =
      memberData.properties["LINEユーザーID"]?.rich_text?.[0]?.plain_text;

    if (lineId) lineUserIds.push(lineId);
  }

  if (lineUserIds.length === 0) {
    return { ok: false, error: "承認者に LINEユーザーID がありません。" };
  }

  // --- 5. 承認URL・否認URL を生成 ---
  const approveUrl = `https://approval.garagetsuno.org/approve?id=${pageId}`;
  const denyUrl = `https://approval.garagetsuno.org/deny?id=${pageId}`;

  // --- 6. Notion に URL を書き込む ---
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

  // --- 7. LINE メッセージ内容 ---
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

  // --- 8. LINE に送信 ---
  for (const lineId of lineUserIds) {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lineToken}`,
      },
      body: JSON.stringify({
        to: lineId,
        messages: [message],
      }),
    });
  }

  return {
    ok: true,
    sentTo: lineUserIds,
  };
}
