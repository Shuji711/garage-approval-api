// /utils/sendApprovalCore.js

import { ensureIssueSequence } from "./issueNumberCore";

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

  // --- 3-1. 承認票DBのロールアップ「LINEユーザーID」を優先的に使う ---
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

  // --- 3-2. ロールアップで取得できなかった場合 → 会員リレーションから取得 ---
  if (lineUserIds.length === 0) {
    const memberRelation = pageData.properties["会員"]?.relation || [];

    for (const member of memberRelation) {
      const memberId = member.id;

      const memberRes = await fetch(
        `https:/
