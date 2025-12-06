// /api/createApprovalTickets.js
// 議案ページ(pageId)から承認票を作成し、対象会員にLINEで承認依頼を送信するAPI
//
// フロー：
//  1. 議案ページの「承認対象」を見る（理事会 / 正会員）
//  2. 会員DBから対象者を自動ピック
//     - 理事会   : 理事 = true かつ 承認システム利用ステータス = "本番" かつ LINE承認有効 = true
//     - 正会員   : 正会員 = true かつ 承認システム利用ステータス = "本番" かつ LINE承認有効 = true
//  3. ピックした人数分、承認票DBに承認票ページを作成
//     - ただし「同じ議案 × 同じ会員」の承認票が既に存在する場合はスキップ（1人1票を保証）
//  4. 各承認票に 送信URL / approveURL / denyURL を書き込み
//  5. 各承認票について sendApprovalMessage(pageId) を呼び出し、LINEに承認依頼を送信
//
// 前提：環境変数
//   NOTION_API_KEY
//   NOTION_MEMBER_DB_ID    … 会員DB
//   NOTION_APPROVAL_DB_ID  … 承認票DB
//   LINE_CHANNEL_ACCESS_TOKEN … sendApprovalCore.js 側で使用

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";
const NOTION_MEMBER_DB_ID = process.env.NOTION_MEMBER_DB_ID;
const NOTION_APPROVAL_DB_ID = process.env.NOTION_APPROVAL_DB_ID;

// 本番ドメイン
const BASE_URL = "https://approval.garagetsuno.org";

// LINE送信用
const { sendApprovalMessage } = require("../utils/sendApprovalCore");

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

async function notionQueryDatabase(databaseId, body) {
  const res = await fetch(
    `https://api.notion.com/v1/databases/${databaseId}/query`,
    {
      method: "POST",
      headers: notionHeaders(),
      body: JSON.stringify(body),
    }
  );
  const text = await res.text();
  if (!res.ok) {
    console.error("Notion queryDatabase error:", text);
    throw new Error("Notion データベースの取得に失敗しました。");
  }
  return JSON.parse(text);
}

async function notionCreatePage(body) {
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: notionHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error("Notion createPage error:", text);
    throw new Error("承認票の作成に失敗しました。");
  }
  return JSON.parse(text);
}

async function notionUpdatePage(pageId, body) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: notionHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error("Notion updatePage error:", text);
    throw new Error("ページの更新に失敗しました。");
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

// 会員ページから氏名とLINEユーザーIDなどを取得
function extractMemberInfo(memberPage) {
  const props = memberPage.properties || {};

  const nameProp = props["氏名"] || props["名前"] || props["フルネーム"];
  const memberName = extractText(nameProp) || "";

  const lineProp = props["LINEユーザーID"];
  let lineUserId = "";
  if (lineProp) {
    if (Array.isArray(lineProp.rich_text)) {
      lineUserId = extractText(lineProp).trim();
    } else if (lineProp.url) {
      lineUserId = (lineProp.url || "").trim();
    }
  }

  const statusProp = props["承認システム利用ステータス"];
  const systemStatus =
    statusProp && statusProp.select && statusProp.select.name
      ? statusProp.select.name
      : "";

  const enabledProp = props["LINE承認有効"];
  const lineEnabled =
    enabledProp && typeof enabledProp.checkbox === "boolean"
      ? enabledProp.checkbox
      : false;

  const isRiji =
    props["理事"] && typeof props["理事"].checkbox === "boolean"
      ? props["理事"].checkbox
      : false;

  const isSeiKaiin =
    props["正会員"] && typeof props["正会員"].checkbox === "boolean"
      ? props["正会員"].checkbox
      : false;

  return {
    memberName,
    lineUserId,
    systemStatus,
    lineEnabled,
    isRiji,
    isSeiKaiin,
  };
}

// 承認対象に応じた会員DBフィルター
function buildMemberFilter(approvalTarget) {
  // 基本フィルタ（承認システム利用ステータスが本番 ＋ LINE承認有効 true）
  const baseConditions = [
    {
      property: "承認システム利用ステータス",
      select: { equals: "本番" },
    },
    {
      property: "LINE承認有効",
      checkbox: { equals: true },
    },
  ];

  if (approvalTarget === "理事会") {
    return {
      and: [
        ...baseConditions,
        {
          property: "理事",
          checkbox: { equals: true },
        },
      ],
    };
  }

  if (approvalTarget === "正会員") {
    return {
      and: [
        ...baseConditions,
        {
          property: "正会員",
          checkbox: { equals: true },
        },
      ],
    };
  }

  // 未対応の承認対象
  return null;
}

// すでに同じ議案 × 同じ会員の承認票が存在するか確認
async function existsTicketForMember(proposalPageId, memberPageId) {
  const result = await notionQueryDatabase(NOTION_APPROVAL_DB_ID, {
    filter: {
      and: [
        {
          property: "議案",
          relation: {
            contains: proposalPageId,
          },
        },
        {
          property: "会員",
          relation: {
            contains: memberPageId,
          },
        },
      ],
    },
    page_size: 1,
  });

  return (result.results || []).length > 0;
}

module.exports = async (req, res) => {
  const { pageId } = req.query; // 議案ページID（ハイフン付き）

  if (!pageId) {
    res.statusCode = 400;
    return res.end("pageId が指定されていません。");
  }

  if (!NOTION_API_KEY || !NOTION_MEMBER_DB_ID || !NOTION_APPROVAL_DB_ID) {
    res.statusCode = 500;
    return res.end(
      "サーバー設定エラー：NOTION_API_KEY / NOTION_MEMBER_DB_ID / NOTION_APPROVAL_DB_ID のいずれかが未設定です。"
    );
  }

  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.statusCode = 405;
      return res.end("Method Not Allowed");
    }

    // 1. 議案ページ取得
    const proposalPage = await notionGetPage(pageId);
    const pProps = proposalPage.properties || {};

    const pTitleProp =
      pProps["議案"] || pProps["名前"] || pProps["タイトル"];
    const proposalTitle = extractText(pTitleProp) || "議案";

    const targetProp =
      pProps["承認対象"] ||
      pProps["承認先"] ||
      pProps["審議先"] ||
      pProps["決裁区分"];
    const approvalTarget =
      targetProp && targetProp.select && targetProp.select.name
        ? targetProp.select.name
        : "";

    // 2. 承認対象に応じて会員DBから対象会員取得
    const memberFilter = buildMemberFilter(approvalTarget);

    if (!memberFilter) {
      const result = {
        status: "ok",
        proposalPageId: proposalPage.id.replace(/-/g, ""),
        proposalTitle,
        approvalTarget,
        memberCount: 0,
        createdCount: 0,
        sentCount: 0,
        tickets: [],
        skipped: [],
      };
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.status(200).end(JSON.stringify(result));
    }

    const memberResult = await notionQueryDatabase(NOTION_MEMBER_DB_ID, {
      filter: memberFilter,
      page_size: 100,
    });

    const memberPages = memberResult.results || [];

    if (memberPages.length === 0) {
      const result = {
        status: "ok",
        proposalPageId: proposalPage.id.replace(/-/g, ""),
        proposalTitle,
        approvalTarget,
        memberCount: 0,
        createdCount: 0,
        sentCount: 0,
        tickets: [],
        skipped: [],
      };
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.status(200).end(JSON.stringify(result));
    }

    // 3. 対象会員ごとに承認票作成＋LINE送信
    const tickets = [];
    const skipped = [];
    let createdCount = 0;
    let sentCount = 0;

    for (const memberPage of memberPages) {
      const memberId = memberPage.id;
      const info = extractMemberInfo(memberPage);
      const {
        memberName,
        lineUserId,
        systemStatus,
        lineEnabled,
        isRiji,
        isSeiKaiin,
      } = info;

      // 念のためサーバー側でも最終チェック
      if (!lineUserId || !lineEnabled || systemStatus !== "本番") {
        skipped.push({
          memberId,
          memberName,
          reason: "LINE未登録または停止中",
        });
        continue;
      }

      // 既に同じ議案 × 同じ会員の承認票が存在する場合は作成・送信しない
      const alreadyExists = await existsTicketForMember(
        proposalPage.id,
        memberId
      );
      if (alreadyExists) {
        skipped.push({
          memberId,
          memberName,
          reason: "既存の承認票が存在するためスキップ",
        });
        continue;
      }

      const ticketTitleText =
        memberName && proposalTitle
          ? `${proposalTitle}／${memberName}`
          : proposalTitle || "承認票";

      const ticketBody = {
        parent: {
          database_id: NOTION_APPROVAL_DB_ID,
        },
        properties: {
          名前: {
            title: [
              {
                text: { content: ticketTitleText },
              },
            ],
          },
          議案: {
            relation: [
              {
                id: proposalPage.id,
              },
            ],
          },
          会員: {
            relation: [
              {
                id: memberId,
              },
            ],
          },
          "コメント（表示用）": {
            rich_text: [],
          },
          // 標準仕様：承認票DB側もプロパティ名は「LINEユーザーID」を使用
          LINEユーザーID: {
            rich_text: [
              {
                text: { content: lineUserId },
              },
            ],
          },
        },
      };

      const ticketPage = await notionCreatePage(ticketBody);
      createdCount += 1;

      const ticketId = ticketPage.id; // ハイフン付き

      // URL系を追記
      const urlBody = {
        properties: {
          送信URL: {
            url: `${BASE_URL}/api/sendApproval?pageId=${ticketId}`,
          },
          approveURL: {
            url: `${BASE_URL}/api/approve?id=${ticketId}`,
          },
          denyURL: {
            url: `${BASE_URL}/api/deny?id=${ticketId}`,
          },
        },
      };

      await notionUpdatePage(ticketId, urlBody);

      // LINE送信（sendApprovalMessage を利用）
      const sendResult = await sendApprovalMessage(ticketId);

      if (sendResult && sendResult.ok) {
        sentCount += 1;
      } else {
        skipped.push({
          memberId,
          memberName,
          reason:
            (sendResult && sendResult.error) ||
            "LINE送信に失敗しました。",
        });
      }

      tickets.push({
        ticketId,
        memberPageId: memberId,
        memberName,
        lineUserId,
        isRiji,
        isSeiKaiin,
      });
    }

    const result = {
      status: "ok",
      proposalPageId: proposalPage.id.replace(/-/g, ""),
      proposalTitle,
      approvalTarget,
      memberCount: memberPages.length,
      createdCount,
      sentCount,
      tickets,
      skipped,
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).end(JSON.stringify(result));
  } catch (err) {
    console.error("createApprovalTickets error:", err);
    res.statusCode = 500;
    return res.end(
      "承認票の作成・送信中にエラーが発生しました。時間をおいて再度お試しください。"
    );
  }
};
