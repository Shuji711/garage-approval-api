// /api/createApprovalTickets.js
// 議案ページ(pageId)から承認票をまとめて作成するAPI
// 仕様：
//  1. 議案ページの「承認対象」を見る（例：理事会）
//  2. 会員DBから、その承認対象に該当する会員を自動ピック
//     - 理事会 → 会員DBの「理事」チェックが ON の会員
//  3. ピックした人数分、承認票DBに承認票ページを作成
//  4. 各承認票に 送信URL / approveURL / denyURL を書き込む
//
// 前提：環境変数
//   NOTION_API_KEY
//   NOTION_MEMBER_DB_ID    … 会員DB
//   NOTION_APPROVAL_DB_ID  … 承認票DB

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";
const NOTION_MEMBER_DB_ID = process.env.NOTION_MEMBER_DB_ID;
const NOTION_APPROVAL_DB_ID = process.env.NOTION_APPROVAL_DB_ID;

// あなたの本番ドメイン
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

// 会員ページから氏名とLINEユーザーIDを取得
function extractMemberInfo(memberPage) {
  const props = memberPage.properties || {};

  const nameProp = props["氏名"] || props["名前"] || props["フルネーム"];
  const memberName = extractText(nameProp) || "";

  const lineProp =
    props["LINEユーザーID"] ||
    props["LINEユーザーID文字列"] ||
    props["LINE ID"];

  let lineUserId = "";
  if (lineProp) {
    if (Array.isArray(lineProp.rich_text)) {
      lineUserId = extractText(lineProp).trim();
    } else if (lineProp.url) {
      lineUserId = (lineProp.url || "").trim();
    }
  }

  return { memberName, lineUserId };
}

// 承認対象に応じて、会員DBのフィルタ条件を作る
function buildMemberFilter(approvalTarget) {
  // まずは「理事会」だけ対応
  if (approvalTarget === "理事会") {
    // 会員DBの「理事」チェックボックスが ON の人を対象にする想定
    return {
      property: "理事",
      checkbox: { equals: true },
    };
  }

  // 将来拡張用（社員総会など）
  // if (approvalTarget === "社員総会") { ... }

  // 承認対象がわからないときはフィルタなし（0件扱いにするため null を返す）
  return null;
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

    // 2. 承認対象に応じて会員DBから対象者を取得
    const memberFilter = buildMemberFilter(approvalTarget);

    if (!memberFilter) {
      // 承認対象が不明 or 未対応の場合は 0 件で返す
      const result = {
        status: "ok",
        proposalPageId: proposalPage.id.replace(/-/g, ""),
        proposalTitle,
        approvalTarget,
        memberCount: 0,
        createdCount: 0,
        tickets: [],
      };
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.status(200).end(JSON.stringify(result));
    }

    const memberQueryBody = {
      filter: memberFilter,
      page_size: 100,
    };

    const memberResult = await notionQueryDatabase(
      NOTION_MEMBER_DB_ID,
      memberQueryBody
    );

    const memberPages = memberResult.results || [];

    if (memberPages.length === 0) {
      const result = {
        status: "ok",
        proposalPageId: proposalPage.id.replace(/-/g, ""),
        proposalTitle,
        approvalTarget,
        memberCount: 0,
        createdCount: 0,
        tickets: [],
      };
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.status(200).end(JSON.stringify(result));
    }

    // 3. 対象会員ごとに承認票を作成
    const tickets = [];
    let createdCount = 0;

    for (const memberPage of memberPages) {
      const memberId = memberPage.id;
      const { memberName, lineUserId } = extractMemberInfo(memberPage);

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
          "LINEユーザーID文字列": {
            rich_text: lineUserId
              ? [
                  {
                    text: { content: lineUserId },
                  },
                ]
              : [],
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

      const updateRes = await fetch(
        `https://api.notion.com/v1/pages/${ticketId}`,
        {
          method: "PATCH",
          headers: notionHeaders(),
          body: JSON.stringify(urlBody),
        }
      );
      const updateText = await updateRes.text();
      if (!updateRes.ok) {
        console.error("Notion update ticket URLs error:", updateText);
      }

      tickets.push({
        ticketId,
        memberPageId: memberId,
        memberName,
        lineUserId,
      });
    }

    const result = {
      status: "ok",
      proposalPageId: proposalPage.id.replace(/-/g, ""),
      proposalTitle,
      approvalTarget,
      memberCount: memberPages.length,
      createdCount,
      tickets,
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).end(JSON.stringify(result));
  } catch (err) {
    console.error("createApprovalTickets error:", err);
    res.statusCode = 500;
    return res.end(
      "承認票の作成中にエラーが発生しました。時間をおいて再度お試しください。"
    );
  }
};
