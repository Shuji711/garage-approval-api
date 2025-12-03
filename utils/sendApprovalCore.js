// /utils/sendApprovalCore.js

const { ensureIssueSequence } = require("./issueNumberCore");

async function sendApprovalMessage(pageId) {
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

  // --- 2.5 議案番号の取得 ---
  let issueNo = "";

  try {
    const proposalRel = pageData.properties["議案"]?.relation || [];
    const proposalPageId = proposalRel[0]?.id;

    if (proposalPageId) {
      await ensureIssueSequence(proposalPageId);

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
    console.error("Issue number generation failed:", e);
  }

  // --- 3. LINEユーザーID の取得 ---
  const lineUserIds = [];

  // 3-1. 承認票DBのロールアップ「LINEユーザーID」を優先的に使う
  const lineRollupProp = pageData.properties["LINEユーザーID"];

  if (lineRollupProp?.type === "rollup" && lineRollupProp.rollup) {
    const roll = lineRollupProp.rollup;

    if (roll.type === "array" && Array.isArray(roll.array)) {
      for (const item of roll.array) {
        const val =
          item.rich_text?.[0]?.plain_text ??
          item.title?.[0]?.plain_text ??
          item.formula?.string ??
          "";
        if (val) lineUserIds.push(val);
      }
    }
  }

  // 3-2. ロールアップで取得できなかった場合 → 会員リレーションから取得
  if (lineUserIds.length === 0) {
    const memberRelation = pageData.properties["会員"]?.relation || [];

    for (const member of memberRelation) {
      const memberId = member.id;

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

      const lineProp = memberData.properties["LINEユーザーID"];
      let lineId = "";

      if (lineProp) {
        lineId =
          lineProp.rich_text?.[0]?.plain_text ??
          lineProp.title?.[0]?.plain_text ??
          lineProp.formula?.string ??
          "";
      }

      if (lineId) {
        lineUserIds.push(lineId);
      }
    }
  }

  // 3-3. まだ取得できなければデバッグ情報を返す
  if (lineUserIds.length === 0) {
    return {
      ok: false,
      error: "LINEユーザーID を取得できませんでした。",
      debug: {
        lineRollup: pageData.properties["LINEユーザーID"],
        memberRelation: pageData.properties["会員"],
      },
    };
  }

  // --- 4. 承認URL・否認URL ---
  const approveUrl = `https://approval.garagetsuno.org/approve?id=${pageId}`;
  const denyUrl = `https://approval.garagetsuno.org/deny?id=${pageId}`;

  // --- 5. Notion に URL を書き込む ---
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

  // --- 6. LINE メッセージ内容 ---
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
