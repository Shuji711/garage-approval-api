// /utils/sendApprovalCore.js
// 承認票DB のページIDを受け取り、関連する議案情報を取得して
// 承認依頼メッセージを LINE に送信する（内容・添付・Notionリンク付き）

const { ensureIssueSequence } = require("./issueNumberCore");

async function sendApprovalMessage(pageId) {
  const notionToken = process.env.NOTION_API_KEY;
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  // --- 1. 承認票ページを取得 ---
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
  const props = pageData.properties || {};

  // 承認票タイトル（名前）
  const title =
    props["名前"]?.title?.[0]?.plain_text ||
    props["タイトル"]?.title?.[0]?.plain_text ||
    "承認依頼";

  // --- 2. 議案ページ関連情報の取得 ---
  let issueNo = "";
  let proposalSummary = "";
  let hasAttachment = false;
  let proposalUrl = "";

  try {
    const proposalRel = props["議案"]?.relation || [];
    const proposalPageId = proposalRel[0]?.id;

    if (proposalPageId) {
      // (1) 議案番号の自動採番（未採番なら振る）
      await ensureIssueSequence(proposalPageId);

      // (2) 採番後の議案ページを再取得
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
        const pProps = proposalData.properties || {};

        // 議案番号（フォーミュラ or 通常プロパティ）
        const issueProp =
          pProps["議案番号フォーミュラ"] ||
          pProps["議案番号"] ||
          pProps["議案番号（自動）"];

        issueNo =
          issueProp?.formula?.string ??
          issueProp?.rich_text?.[0]?.plain_text ??
          "";

        // 発議内容（内容（説明））を要約
        const descSource = pProps["内容（説明）"]?.rich_text;
        if (Array.isArray(descSource) && descSource.length > 0) {
          const fullText = descSource
            .map((r) => r.plain_text || "")
            .join("");
          proposalSummary =
            fullText.length > 120
              ? fullText.slice(0, 120) + "…"
              : fullText;
        }

        // 添付資料の有無
        const filesProp = pProps["添付資料"];
        if (filesProp && Array.isArray(filesProp.files)) {
          hasAttachment = filesProp.files.length > 0;
        }

        // Notion 議案ページURL（IDのハイフンを外して生成）
        const cleanId = proposalPageId.replace(/-/g, "");
        proposalUrl = `https://www.notion.so/${cleanId}`;
      }
    }
  } catch (e) {
    console.error("Issue / proposal info fetch failed:", e);
    // ここでエラーになっても承認依頼自体は送る
  }

  // --- 3. 承認票から LINE 送信先の取得 ---
  const memberRel = props["会員"]?.relation || [];
  const lineRollup = props["LINEユーザーID"];

  const lineUserIds = [];

  // ① ロールアップから取得（標準ルート）
  if (lineRollup && lineRollup.type === "rollup") {
    const roll = lineRollup.rollup;
    if (roll && roll.type === "array" && Array.isArray(roll.array)) {
      for (const item of roll.array) {
        if (item.type === "rich_text" && item.rich_text?.length) {
          const idText = item.rich_text[0].plain_text;
          if (idText) lineUserIds.push(idText);
        }
      }
    }
  }

  // ② 念のため、会員リレーション経由で補完（ロールアップが空の場合）
  if (lineUserIds.length === 0 && memberRel.length > 0) {
    for (const rel of memberRel) {
      const memberId = rel.id;
      try {
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
        const mProps = memberData.properties || {};
        const lineText =
          mProps["LINEユーザーID"]?.rich_text?.[0]?.plain_text || "";
        if (lineText) lineUserIds.push(lineText);
      } catch (e) {
        console.error("Fetch member for LINE ID failed:", e);
      }
    }
  }

  if (lineUserIds.length === 0) {
    return {
      ok: false,
      error: "LINEユーザーID を取得できませんでした。",
    };
  }

  // --- 4. 承認URL・否認URL を生成して Notion に書き戻す ---
  const approveUrl = `https://approval.garagetsuno.org/approve?id=${pageId}`;
  const denyUrl = `https://approval.garagetsuno.org/deny?id=${pageId}`;

  try {
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
  } catch (e) {
    console.error("Failed to write approve/deny URL to Notion:", e);
    // URL書き込み失敗でも、LINE送信は続行
  }

  // --- 5. LINE Flex メッセージ構築 ---
  const bodyContents = [
    { type: "text", text: "承認依頼", weight: "bold", size: "lg" },
  ];

  if (issueNo) {
    bodyContents.push({
      type: "text",
      text: `議案番号：${issueNo}`,
      size: "sm",
      margin: "md",
    });
  }

  // 承認票タイトル
  bodyContents.push({
    type: "text",
    text: title,
    wrap: true,
    margin: "md",
  });

  // 発議内容サマリ
  if (proposalSummary) {
    bodyContents.push({
      type: "text",
      text: proposalSummary,
      wrap: true,
      size: "sm",
      margin: "sm",
    });
  }

  // 添付資料の有無
  if (hasAttachment) {
    bodyContents.push({
      type: "text",
      text: "添付資料：あり",
      size: "xs",
      margin: "sm",
    });
  }

  // フッター（ボタン）
  const footerContents = [];

  // 議案ページを開くボタン
  if (proposalUrl) {
    footerContents.push({
      type: "button",
      action: {
        type: "uri",
        label: "内容を確認する（Notion）",
        uri: proposalUrl,
      },
      style: "secondary",
    });
  }

  // 承認・否認ボタン
  footerContents.push(
    {
      type: "button",
      action: { type: "uri", label: "承認する", uri: approveUrl },
      style: "primary",
      margin: "md",
    },
    {
      type: "button",
      action: { type: "uri", label: "否認する", uri: denyUrl },
      style: "secondary",
      margin: "md",
    }
  );

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
        contents: footerContents,
        spacing: "sm",
      },
    },
  };

  // --- 6. LINE に送信 ---
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
    proposalUrl,
  };
}

module.exports = {
  sendApprovalMessage,
};
