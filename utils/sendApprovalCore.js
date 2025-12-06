// /utils/sendApprovalCore.js
// 承認票ページ(pageId)から情報を取り出し、承認者にLINEで承認依頼を送る。
// - Notion: 承認票DB ＋ 関連議案ページを参照
// - LINE: push API で Flex メッセージ送信
//
// 前提：環境変数
//   NOTION_API_KEY
//   LINE_CHANNEL_ACCESS_TOKEN
//   (option) BASE_URL = "https://approval.garagetsuno.org"

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const BASE_URL =
  process.env.BASE_URL || "https://approval.garagetsuno.org";

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_API_KEY}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notionGetPage(pageId) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "GET",
    headers: notionHeaders(),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error("Notion getPage error:", text);
    throw new Error("Notion ページの取得に失敗しました。");
  }
  return JSON.parse(text);
}

function extractText(prop) {
  if (!prop) return "";
  if (Array.isArray(prop.title) && prop.title.length > 0) {
    return prop.title.map((t) => t.plain_text || "").join("");
  }
  if (Array.isArray(prop.rich_text) && prop.rich_text.length > 0) {
    return prop.rich_text.map((t) => t.plain_text || "").join("");
  }
  return "";
}

// Flexメッセージ生成
function buildFlexMessage({
  ticketTitle,
  proposalTitle,
  description,
  approvalTarget,
  deadlineText,
  formUrl,
}) {
  const headerText = proposalTitle || ticketTitle || "議案の承認依頼";
  const descText = description || "内容を確認のうえ、承認または否認をお願いします。";

  const bodyContents = [
    {
      type: "text",
      text: headerText,
      weight: "bold",
      size: "md",
      wrap: true,
    },
    {
      type: "text",
      text: descText,
      size: "sm",
      margin: "md",
      wrap: true,
    },
  ];

  if (approvalTarget) {
    bodyContents.push({
      type: "text",
      text: `【承認先】${approvalTarget}`,
      size: "xs",
      margin: "md",
      color: "#666666",
      wrap: true,
    });
  }

  if (deadlineText) {
    bodyContents.push({
      type: "text",
      text: `【承認期限】${deadlineText}`,
      size: "xs",
      margin: "sm",
      color: "#d32f2f",
      wrap: true,
    });
  }

  return {
    type: "flex",
    altText: headerText,
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
        spacing: "md",
        contents: [
          {
            type: "button",
            style: "primary",
            action: {
              type: "uri",
              label: "内容を確認する",
              // ★ ここが重要：ブラウザ承認ページ sendApprovalGet に飛ばす
              uri: formUrl,
            },
          },
        ],
      },
    },
  };
}

// 実行本体
async function sendApprovalMessage(pageId) {
  if (!NOTION_API_KEY) {
    return {
      ok: false,
      error: "NOTION_API_KEY が未設定です。",
    };
  }
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    return {
      ok: false,
      error: "LINE_CHANNEL_ACCESS_TOKEN が未設定です。",
    };
  }

  // 1. 承認票ページを取得
  const ticketPage = await notionGetPage(pageId);
  const tProps = ticketPage.properties || {};

  // 承認票タイトル
  const tTitleProp = tProps["名前"] || tProps["タイトル"];
  const ticketTitle = extractText(tTitleProp) || "承認票";

  // 承認結果が既に入っていれば送らない（任意だが安全側）
  const resultProp = tProps["承認結果"];
  const alreadyResult =
    resultProp && resultProp.select && resultProp.select.name
      ? resultProp.select.name
      : null;
  if (alreadyResult) {
    return {
      ok: false,
      error: `この承認票は既に「${alreadyResult}」として登録されています。`,
    };
  }

  // LINEユーザーID取得（承認票DB側の「LINEユーザーID文字列」を優先）
  let lineUserId = "";
  const lineIdProp =
    tProps["LINEユーザーID文字列"] ||
    tProps["LINEユーザーID"] ||
    tProps["LINE ID"];

  if (lineIdProp) {
    if (Array.isArray(lineIdProp.rich_text) && lineIdProp.rich_text.length > 0) {
      lineUserId = extractText(lineIdProp).trim();
    } else if (lineIdProp.url) {
      lineUserId = (lineIdProp.url || "").trim();
    }
  }

  if (!lineUserId) {
    return {
      ok: false,
      error: "LINEユーザーIDが承認票から取得できませんでした。",
      debug: { pageId },
    };
  }

  // 関連議案ページ情報取得（あれば）
  let proposalTitle = "";
  let description = "";
  let approvalTarget = "";
  let deadlineText = "";

  const relProp = tProps["議案"];
  if (relProp && Array.isArray(relProp.relation) && relProp.relation.length > 0) {
    const proposalId = relProp.relation[0].id;
    const proposalPage = await notionGetPage(proposalId);
    const pProps = proposalPage.properties || {};

    const pTitleProp = pProps["議案"] || pProps["名前"] || pProps["タイトル"];
    proposalTitle = extractText(pTitleProp) || "";

    const descProp =
      pProps["内容（説明）"] ||
      pProps["内容"] ||
      pProps["説明"];
    description = extractText(descProp) || "";

    const targetProp =
      pProps["承認対象"] ||
      pProps["承認先"] ||
      pProps["審議先"] ||
      pProps["決裁区分"];
    approvalTarget =
      targetProp && targetProp.select && targetProp.select.name
        ? targetProp.select.name
        : "";

    const deadlineProp =
      pProps["承認期限"] ||
      pProps["回答期限"] ||
      pProps["期限"];
    if (deadlineProp && deadlineProp.date && deadlineProp.date.start) {
      deadlineText = deadlineProp.date.start;
    }
  }

  // 2. ブラウザ承認フォームURL（sendApprovalGet）を組み立て
  const formUrl = `${BASE_URL}/api/sendApprovalGet?pageId=${pageId}`;

  // 3. Flexメッセージ生成
  const flexMessage = buildFlexMessage({
    ticketTitle,
    proposalTitle,
    description,
    approvalTarget,
    deadlineText,
    formUrl,
  });

  // 4. LINE push
  const lineBody = {
    to: lineUserId,
    messages: [flexMessage],
  };

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(lineBody),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error("LINE push error:", text);
    return {
      ok: false,
      error: "LINE push failed",
      debug: text,
    };
  }

  return {
    ok: true,
    sentTo: [lineUserId],
  };
}

module.exports = {
  sendApprovalMessage,
};
