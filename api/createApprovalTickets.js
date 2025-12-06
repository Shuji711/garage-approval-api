// /api/createApprovalTickets.js
// 議案DBの「送信用URL」から呼び出され、承認票DBに承認票ページを生成するAPI
// 環境変数：NOTION_API_KEY, NOTION_APPROVAL_DB_ID, NOTION_MEMBER_DB_ID

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";
const APPROVAL_DB_ID = process.env.NOTION_APPROVAL_DB_ID;
const MEMBER_DB_ID = process.env.NOTION_MEMBER_DB_ID;

/**
 * 会員DBのプロパティ定義
 * ※ Notion の実プロパティ名に合わせてある
 */
const MEMBER_PROP_NAME = "氏名"; // 氏名（タイトル）でもOK。実際は「氏名」列だが、タイトルを優先的に拾う
const MEMBER_PROP_LINE_ID = "LINEユーザーID";
const MEMBER_PROP_IS_BOARD = "理事";                // チェックボックス
const MEMBER_PROP_IS_MEMBER = "正会員";            // チェックボックス
const MEMBER_PROP_STATUS = "承認システム利用ステータス"; // セレクト
const MEMBER_STATUS_ACTIVE = "本番";
const MEMBER_PROP_LINE_ENABLED = "LINE承認有効";   // チェックボックス

/**
 * Notion 共通ヘッダ
 */
function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_API_KEY}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

/**
 * ページ取得（議案／会員／承認票 共通）
 */
async function getPage(pageId) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "GET",
    headers: notionHeaders(),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error("Notion getPage error:", text);
    throw new Error(`Failed to fetch Notion page: ${text}`);
  }

  return JSON.parse(text);
}

/**
 * データベースクエリ（会員DB用）
 */
async function queryDatabase(databaseId, body) {
  const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: "POST",
    headers: notionHeaders(),
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error("Notion queryDatabase error:", text);
    throw new Error(`Failed to query Notion database: ${text}`);
  }

  return JSON.parse(text);
}

/**
 * タイトル or リッチテキストからテキストを取り出すユーティリティ
 */
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

/**
 * 承認対象に応じて会員DBのフィルタ条件を返す
 * - 議案DBの select プロパティ「承認対象」を想定
 */
function buildMemberFilter(approvalTargetName) {
  let roleFilter = null;

  if (approvalTargetName === "理事会") {
    // 理事チェック済み
    roleFilter = {
      property: MEMBER_PROP_IS_BOARD,
      checkbox: { equals: true },
    };
  } else if (approvalTargetName === "正会員" || approvalTargetName === "社員総会") {
    // 正会員チェック済み
    roleFilter = {
      property: MEMBER_PROP_IS_MEMBER,
      checkbox: { equals: true },
    };
  } else {
    return null;
  }

  const filters = [roleFilter];

  // 承認システム利用ステータス = 本番
  filters.push({
    property: MEMBER_PROP_STATUS,
    select: { equals: MEMBER_STATUS_ACTIVE },
  });

  // LINE承認有効 = true
  filters.push({
    property: MEMBER_PROP_LINE_ENABLED,
    checkbox: { equals: true },
  });

  if (filters.length === 1) {
    return filters[0];
  }

  return { and: filters };
}

/**
 * createApprovalTickets メインハンドラ
 */
module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ status: "error", message: "Method Not Allowed" });
  }

  const { pageId } = req.query;

  if (!pageId) {
    return res
      .status(400)
      .json({ status: "error", message: "pageId が指定されていません" });
  }

  if (!NOTION_API_KEY || !APPROVAL_DB_ID || !MEMBER_DB_ID) {
    return res.status(500).json({
      status: "error",
      message:
        "サーバー設定エラー：NOTION_API_KEY / NOTION_APPROVAL_DB_ID / NOTION_MEMBER_DB_ID を確認してください",
    });
  }

  try {
    // 1. 議案ページを取得
    const proposalPage = await getPage(pageId);
    const props = proposalPage.properties || {};

    // 議案タイトル（なければ無題）
    const titleProp = props["議案"] || props["名前"];
    const proposalTitle = extractText(titleProp) || "無題議案";

    // 2. 承認対象を取得（select）
    const approvalTargetProp = props["承認対象"];
    const approvalTargetName =
      approvalTargetProp &&
      approvalTargetProp.select &&
      approvalTargetProp.select.name
        ? approvalTargetProp.select.name
        : null;

    if (!approvalTargetName) {
      return res.status(400).json({
        status: "error",
        message: "承認対象 が設定されていません（議案DBの「承認対象」プロパティを確認してください）",
      });
    }

    const memberFilter = buildMemberFilter(approvalTargetName);
    if (!memberFilter) {
      return res.status(400).json({
        status: "error",
        message: `承認対象「${approvalTargetName}」に対応する会員抽出条件が未定義です（createApprovalTickets.js の buildMemberFilter を修正してください）`,
      });
    }

    // 3. 会員DBから対象メンバーを取得
    const memberQueryBody = {
      page_size: 100,
      filter: memberFilter,
    };

    const memberResult = await queryDatabase(MEMBER_DB_ID, memberQueryBody);
    const memberPages = memberResult.results || [];

    if (memberPages.length === 0) {
      return res.status(400).json({
        status: "error",
        message: `承認対象「${approvalTargetName}」に該当する会員が見つかりません（会員DBを確認してください）`,
      });
    }

    // 4. 既存承認票から「すでに承認票がある会員」を取得して重複作成を防ぐ
    const ticketRelProp = props["承認票DB"]; // 議案DB → 承認票DB のリレーション
    const ticketRelations = ticketRelProp && Array.isArray(ticketRelProp.relation)
      ? ticketRelProp.relation
      : [];

    const existingMemberIds = new Set();

    for (const ticket of ticketRelations) {
      const ticketPage = await getPage(ticket.id);
      const ticketProps = ticketPage.properties || {};
      const memberProp = ticketProps["会員"];

      if (memberProp && Array.isArray(memberProp.relation)) {
        for (const rel of memberProp.relation) {
          if (rel && rel.id) {
            existingMemberIds.add(rel.id);
          }
        }
      }
    }

    // 5. 対象メンバーごとに承認票を作成
    const createdTickets = [];

    for (const memberPage of memberPages) {
      const memberPageId = memberPage.id;
      if (!memberPageId) continue;

      // すでに承認票がある会員はスキップ
      if (existingMemberIds.has(memberPageId)) {
        continue;
      }

      const memberProps = memberPage.properties || {};

      const memberNameTitle =
        memberProps["名前"] && memberProps["名前"].title
          ? extractText(memberProps["名前"])
          : "";
      const memberNameProp =
        memberProps[MEMBER_PROP_NAME] || memberProps["氏名"] || memberProps["会員名"];

      const memberName =
        memberNameTitle ||
        extractText(memberNameProp) ||
        "承認者";

      const lineIdProp = memberProps[MEMBER_PROP_LINE_ID];
      const lineUserId = extractText(lineIdProp); // 空でもOK

      const ticketTitle = `${proposalTitle}／${memberName}`;

      // 承認票DBにページを作成
      const body = {
        parent: { database_id: APPROVAL_DB_ID },
        properties: {
          // 名前（タイトル）
          "名前": {
            title: [
              {
                text: { content: ticketTitle },
              },
            ],
          },
          // 議案（リレーション）
          "議案": {
            relation: [{ id: pageId }],
          },
          // 会員（リレーション：会員DB）
          "会員": {
            relation: [{ id: memberPageId }],
          },
          // LINEユーザーID
          "LINEユーザーID": lineUserId
            ? {
                rich_text: [
                  {
                    text: { content: lineUserId },
                  },
                ],
              }
            : {
                rich_text: [],
              },
          // コメントは空で初期化
          "コメント": {
            rich_text: [],
          },
        },
      };

      const createRes = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: notionHeaders(),
        body: JSON.stringify(body),
      });

      const createText = await createRes.text();
      if (!createRes.ok) {
        console.error("Notion create ticket error:", createText);
        throw new Error(`承認票の作成に失敗しました: ${createText}`);
      }

      const ticketPage = JSON.parse(createText);

      createdTickets.push({
        ticketId: ticketPage.id,
        memberPageId,
        memberName,
        lineUserId,
      });
    }

    return res.status(200).json({
      status: "ok",
      proposalPageId: pageId,
      proposalTitle,
      approvalTarget: approvalTargetName,
      memberCount: memberPages.length,
      createdCount: createdTickets.length,
      tickets: createdTickets,
    });
  } catch (err) {
    console.error("createApprovalTickets error:", err);
    return res.status(500).json({
      status: "error",
      message: err.message || "internal server error",
    });
  }
};
