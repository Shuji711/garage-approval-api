// /utils/sendApprovalCore.js

import { ensureIssueSequence } from "@/utils/issueNumberCore";

export async function sendApprovalMessage(pageId) {
  const notionToken = process.env.NOTION_API_KEY;
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  // --- 1. Notion から承認票ページ詳細を取得 ---
  const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
  });

  if (!pageRes.ok) {
    const txt = await pageRes.text();
    throw new Error(
      `Failed to fetch approval page: ${pageRes.status} ${txt || pageRes.statusText}`
    );
  }

  const pageData = await pageRes.json();

  // --- 2. タイトルを取得（プロパティ名：名前） ---
  const title =
    pageData.properties["名前"]?.title?.[0]?.plain_text || "承認依頼";

  // --- 2.5 議案番号の取得（議案DB 側で自動採番） ---
  let issueNo = "";

  try {
    // 承認票ページの「議案」リレーションから議案ページIDを取得
    const proposalRel = pageData.properties["議案"]?.relation || [];
    const proposalPageId = proposalRel[0]?.id;

    if (proposalPageId) {
      // ① 連番を自動採番（未採番なら振る）
      await ensureIssueSequence(proposalPageId);

      // ② 採番後の議案ページを再取得
      const proposalRes = await fetch(
        `https://api.notion.com/v1/pages/${proposalPageId}`,
        {
          headers: {
            Authorization: `Bearer ${notionToken}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
          },
        }
      );

      if (proposalRes.ok) {
        const proposalData = await proposalRes.json();

        // 議案番号プロパティ（名前は環境に合わせて変更可）
        const issueProp =
          proposalData.properties["議案番号フォーミュラ"] ||
          proposalData.properties["議案番号"];

        issueNo =
          issueProp?.formula?.string ??
          issueProp?.rich_text?.[0]?.plain_text ??
          "";
      }
    }
  } catch (e) {
    // 議案番号周りでエラーが出ても、承認依頼自体は送る
    console.error("Issue number generation failed:", e);
  }

  // --- 3. 承認者（リレーション）から 会員DB のページID を取得 ---
  const approverRelation = pageData.properties["承認者"]?.relation || [];

  if (approverRelation.length === 0) {
    return { ok: false, error: "承認者が設定されていません。" };
  }

  // --- 4. 会員DBの各ページから LINEユーザーID を取得 ---
  const lineUserIds = [];

  for (const person of approverRelation) {
    const memberId = person.id;

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

    if (!memberRes.ok) continue;

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

  // --- 6. Notion に URL を書き込む（プロパティ名：approveURL / denyURL） ---
  await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        approveURL: { url: approveUrl },
        denyURL: { url: denyUrl },
      },
    }),
  });

  // --- 7. LINE メッセージ内容（Flex） ---
  const bodyContents = [
    { type: "text", text: "承認依頼", weight: "bold", size: "lg" },
  ];

  // 議案番号が取れていれば表示行を追加
  if (issueNo) {
    bodyContents.push({
      type: "text",
      text: `議案番号：${issueNo}`,
      size: "sm",
      margin: "md",
    });
  }

  // 件名
  bodyContents.push({
    type: "text",
    text: title,
    wrap: true,
    margin: "md",
  });

  const message = {
    type: "flex",
    altText: "承認依頼があります",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: bodyContents,
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
    issueNo,
  };
}
