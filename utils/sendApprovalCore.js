// /utils/sendApprovalCore.js
// 承認票ページIDを受け取り、その承認票に紐づく会員の LINE ユーザーID 宛てに
// 承認依頼メッセージを送信するモジュール。
//
// ・承認票DB側のプロパティ名は「LINEユーザーID」を使用（文字列型：リッチテキスト or URL を想定）
// ・議案名などの表示情報は、承認票 -> 議案リレーションから取得
// ・ボタン「内容を確認する」→ /api/sendApprovalGet?pageId=承認票ID に遷移
//
// 返り値：
//   { ok: true, sentTo: [lineUserId] }
//   { ok: false, error: "エラーメッセージ" }

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// 本番ドメイン（ブラウザ承認フォーム用）
const BASE_URL = "https://approval.garagetsuno.org";

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

// 承認票ページから LINEユーザーID／会員名／議案情報を取得
async function extractTicketContext(ticketPageId) {
  const ticketPage = await notionGetPage(ticketPageId);
  const tProps = ticketPage.properties || {};

  // 承認票タイトル（議案名／氏名などが入っている想定）
  const tTitleProp = tProps["名前"] || tProps["タイトル"];
  const ticketTitle = extractText(tTitleProp) || "承認依頼";

  // LINEユーザーID（承認票DB側のプロパティ名は「LINEユーザーID」）
  const lineProp = tProps["LINEユーザーID"];
  let lineUserId = "";
  if (lineProp) {
    if (Array.isArray(lineProp.rich_text)) {
      lineUserId = extractText(lineProp).trim();
    } else if (lineProp.url) {
      lineUserId = (lineProp.url || "").trim();
    }
  }

  // 会員名（会員リレーションから取得／任意）
  let memberName = "";
  const memberRel = tProps["会員"];
  if (
    memberRel &&
    Array.isArray(memberRel.relation) &&
    memberRel.relation.length > 0
  ) {
    const memberId = memberRel.relation[0].id;
    try {
      const memberPage = await notionGetPage(memberId);
      const mProps = memberPage.properties || {};
      const mNameProp =
        mProps["氏名"] || mProps["名前"] || mProps["フルネーム"];
      memberName = extractText(mNameProp) || "";
    } catch (e) {
      console.warn("会員ページ取得に失敗しました（継続）:", e);
    }
  }

  // 議案情報（タイトル・内容要約）
  let proposalTitle = "";
  let description = "";

  const proposalRel = tProps["議案"];
  if (
    proposalRel &&
    Array.isArray(proposalRel.relation) &&
    proposalRel.relation.length > 0
  ) {
    const proposalId = proposalRel.relation[0].id;
    try {
      const proposalPage = await notionGetPage(proposalId);
      const pProps = proposalPage.properties || {};

      const pTitleProp =
        pProps["議案"] || pProps["名前"] || pProps["タイトル"];
      proposalTitle = extractText(pTitleProp) || "";

      const descProp =
        pProps["内容（説明）"] ||
        pProps["内容"] ||
        pProps["説明"];
      description = extractText(descProp) || "";
    } catch (e) {
      console.warn("議案ページ取得に失敗しました（継続）:", e);
    }
  }

  return {
    ticketTitle,
    lineUserId,
    memberName,
    proposalTitle,
    description,
  };
}

// Flex メッセージ生成
function buildFlexMessage({
  ticketPageId,
  ticketTitle,
  memberName,
  proposalTitle,
  description,
}) {
  const formUrl = `${BASE_URL}/api/sendApprovalGet?pageId=${ticketPageId}`;

  const altBase = proposalTitle || ticketTitle || "承認依頼";
  const altText = `承認依頼：${altBase}`;

  // 内容要約（長すぎると読みにくいのでざっくりカット）
  const descShort = description
    ? description.length > 80
      ? description.slice(0, 80) + "…"
      : description
    : "";

  const headerText = "Garage Tsuno 承認依頼";

  const bodyContents = [];

  if (proposalTitle) {
    bodyContents.push({
      type: "text",
      text: proposalTitle,
      weight: "bold",
      size: "md",
      wrap: true,
    });
  }

  if (memberName) {
    bodyContents.push({
      type: "text",
      text: `宛先：${memberName} 様`,
      size: "sm",
      color: "#555555",
      wrap: true,
      margin: "lg",
    });
  }

  if (descShort) {
    bodyContents.push({
      type: "text",
      text: descShort,
      size: "sm",
      color: "#555555",
      wrap: true,
      margin: "md",
    });
  }

  bodyContents.push({
    type: "text",
    text: "内容を確認のうえ、承認または否認をお願いします。",
    size: "xs",
    color: "#888888",
    wrap: true,
    margin: "md",
  });

  const flexContents = {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        {
          type: "text",
          text: headerText,
          weight: "bold",
          size: "sm",
          color: "#999999",
        },
        ...bodyContents,
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        {
          type: "button",
          style: "primary",
          action: {
            type: "uri",
            label: "内容を確認する",
            uri: formUrl,
          },
        },
        {
          type: "text",
          text: "タップするとブラウザが開きます。",
          size: "xs",
          color: "#888888",
          align: "center",
          margin: "md",
          wrap: true,
        },
      ],
      flex: 0,
    },
  };

  return {
    type: "flex",
    altText,
    contents: flexContents,
  };
}

async function sendLinePush(lineUserId, message) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    return {
      ok: false,
      error: "LINE_CHANNEL_ACCESS_TOKEN が未設定です。",
    };
  }

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: lineUserId,
      messages: [message],
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error("LINE push error:", text);
    return {
      ok: false,
      error: `LINE push failed: ${text}`,
    };
  }

  return { ok: true };
}

async function sendApprovalMessage(ticketPageId) {
  try {
    if (!NOTION_API_KEY) {
      return {
        ok: false,
        error: "NOTION_API_KEY が未設定です。",
      };
    }

    const ctx = await extractTicketContext(ticketPageId);
    const { ticketTitle, lineUserId, memberName, proposalTitle, description } =
      ctx;

    if (!lineUserId) {
      return {
        ok: false,
        error: "LINEユーザーIDが承認票から取得できませんでした。",
      };
    }

    const flexMessage = buildFlexMessage({
      ticketPageId,
      ticketTitle,
      memberName,
      proposalTitle,
      description,
    });

    const result = await sendLinePush(lineUserId, flexMessage);
    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      sentTo: [lineUserId],
    };
  } catch (e) {
    console.error("sendApprovalMessage error:", e);
    return {
      ok: false,
      error: "承認依頼メッセージの送信中にエラーが発生しました。",
    };
  }
}

module.exports = {
  sendApprovalMessage,
};
