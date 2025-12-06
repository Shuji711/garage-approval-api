// /api/createApprovalTickets.js
// 議案ページ(pageId)から承認票をまとめて作成するAPI
// - GET /api/createApprovalTickets?pageId=xxxxx
//  1. 議案ページを取得
//  2. 承認対象の会員リストを取得（Relation想定）
//  3. 会員ごとに 承認票DB にページを作成
//  4. 承認票に 送信URL / approveURL / denyURL / LINEユーザーID文字列 を設定
//  5. 作成結果をJSONで返す
//
// 前提：環境変数に以下を設定しておくこと
// - NOTION_API_KEY
// - NOTION_TICKET_DB_ID  …… 承認票DBの database_id
//
// 会員DBや議案DBのIDはここでは使わず、
// 「議案」Relation や 会員Relation から辿る前提にしている。

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";
const NOTION_TICKET_DB_ID = process.env.NOTION_TICKET_DB_ID;

// あなたの本番ドメインに合わせて変更
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

// 会員ページから氏名とLINEユーザーIDを抜き出す
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
    if (lineProp.rich_text && Array.isArray(lineProp.rich_text)) {
      lineUserId = extractText(lineProp);
    } else if (lineProp.url) {
      lineUserId = lineProp.url;
    }
  }

  return { memberName, lineUserId };
}

module.exports = async (req, res) => {
  const { pageId } = req.query; // 議案ページID（Notionの id() をハイフンなしで渡している想定）

  if (!pageId) {
    res.statusCode = 400;
    return res.end("pageId が指定されていません。");
  }

  if (!NOTION_API_KEY || !NOTION_TICKET_DB_ID) {
    res.statusCode = 500;
    return res.end(
      "サーバー設定エラー：NOTION_API_KEY または NOTION_TICKET_DB_ID が未設定です。"
    );
  }

  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.statusCode = 405;
      return res.end("Method Not Allowed");
    }

    // 1. 議案ページを取得
    const proposalPage = await notionGetPage(pageId);
    const pProps = proposalPage.properties || {};

    // 議案タイトル
    const pTitleProp =
      pProps["議案"] || pProps["名前"] || pProps["タイトル"];
    const proposalTitle = extractText(pTitleProp) || "議案";

    // 承認先（例：理事会・社員総会など） ※あれば返却JSONに入れるだけ
    const targetProp =
      pProps["承認対象"] ||
      pProps["承認先"] ||
      pProps["審議先"] ||
      pProps["決裁区分"];
    const approvalTarget =
      targetProp && targetProp.select && targetProp.select.name
        ? targetProp.select.name
        : "";

    // 2. 対象会員Relation を取得
    //   プロパティ名は環境に合わせて必要ならここを書き換える
    const relMembersProp =
      pProps["対象会員"] ||
      pProps["承認対象会員"] ||
      pProps["会員"] ||
      pProps["宛先会員"];

    if (
      !relMembersProp ||
      !Array.isArray(relMembersProp.relation) ||
      relMembersProp.relation.length === 0
    ) {
      // 対象会員がゼロの場合もエラーではなくそのまま返す
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

    const memberRelations = relMembersProp.relation;
    const tickets = [];
    let createdCount = 0;

    // 3. 会員ごとに承認票を作成
    for (const rel of memberRelations) {
      const memberPageId = rel.id;
      const memberPage = await notionGetPage(memberPageId);
      const { memberName, lineUserId } = extractMemberInfo(memberPage);

      // 承認票タイトル
      const ticketTitleText =
        memberName && proposalTitle
          ? `${proposalTitle}／${memberName} 様`
          : proposalTitle || "承認票";

      // 承認票ページ作成
      const ticketBody = {
        parent: {
          database_id: NOTION_TICKET_DB_ID,
        },
        properties: {
          // タイトル
          名前: {
            title: [
              {
                text: { content: ticketTitleText },
              },
            ],
          },
          // 議案とのRelation
          議案: {
            relation: [
              {
                id: proposalPage.id,
              },
            ],
          },
          // 会員とのRelation
          会員: {
            relation: [
              {
                id: memberPageId,
              },
            ],
          },
          // コメント（表示用）は空で初期化
          "コメント（表示用）": {
            rich_text: [],
          },
          // LINEユーザーID文字列（表示用）
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

      // 4. 承認票に URL 系プロパティを追加更新
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
        // URL更新に失敗しても致命的ではないので、チケット自体は結果に含める
      }

      tickets.push({
        ticketId,
        memberPageId,
        memberName,
        lineUserId,
      });
    }

    // 5. 結果JSONを返却
    const result = {
      status: "ok",
      proposalPageId: proposalPage.id.replace(/-/g, ""),
      proposalTitle,
      approvalTarget,
      memberCount: memberRelations.length,
      createdCount,
      tickets,
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).end(JSON.stringify(result));
  } catch (err) {
    console.error("createApprovalTickets error:", err);
    res.statusCode = 500;
    return res.end("承認票の作成中にエラーが発生しました。時間をおいて再度お試しください。");
  }
};
