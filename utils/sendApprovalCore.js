// /utils/sendApprovalCore.js

// ===== 設定ここだけ確認 =====

// 承認フォーム（内容確認画面）のURLベース
// ブラウザで開くURLが違う場合は、ここのみ修正してください。
const APPROVAL_FORM_BASE_URL = "https://approval.garagetsuno.org/approval";

// Notion のバージョン
const NOTION_VERSION = "2022-06-28";

// =============================

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// 承認フォームURLからドメイン部分を取り出して approve/deny のベースURLを作る
// 例）https://approval.garagetsuno.org/approval
//      → origin = https://approval.garagetsuno.org
//      → approve = https://approval.garagetsuno.org/approve
//      → deny    = https://approval.garagetsuno.org/deny
const APPROVAL_ORIGIN = new URL(APPROVAL_FORM_BASE_URL).origin;
const APPROVE_URL_BASE = `${APPROVAL_ORIGIN}/approve`;
const DENY_URL_BASE = `${APPROVAL_ORIGIN}/deny`;

/**
 * Notion API 共通呼び出し
 */
async function notionRequest(path, method = "GET", body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Notion API error:", res.status, text);
    throw new Error(`Notion API error: ${res.status}`);
  }

  return res.json();
}

/**
 * 承認票ページから、会員DB経由で LINEユーザーID の配列を取得する
 *
 * 前提：
 * - 承認票DBに 会員DB へのリレーションプロパティ「会員」がある
 * - 会員DBに、文字列プロパティ「LINEユーザーID」がある
 * - 会員DBに、セレクト「承認システム利用ステータス」がある（本番/テスト/停止）
 * - 会員DBに、チェックボックス「LINE承認有効」がある
 */
async function getLineUserIdsFromApprovalPage(approvalPageId) {
  const page = await notionRequest(`/pages/${approvalPageId}`, "GET");
  const props = page.properties;

  const memberRelationProp = props["会員"];
  if (!memberRelationProp || memberRelationProp.type !== "relation") {
    console.warn("承認票ページに「会員」リレーションがありません。");
    return [];
  }

  const relatedMembers = memberRelationProp.relation || [];
  if (!relatedMembers.length) {
    console.warn("承認票ページの「会員」リレーションにレコードが設定されていません。");
    return [];
  }

  const lineUserIds = [];

  for (const rel of relatedMembers) {
    const memberId = rel.id;
    const memberPage = await notionRequest(`/pages/${memberId}`, "GET");
    const mProps = memberPage.properties;

    // 1. 承認システム利用ステータス が "本番" 以外はスキップ
    const statusProp = mProps["承認システム利用ステータス"];
    let status = "";
    if (statusProp && statusProp.type === "select" && statusProp.select) {
      status = statusProp.select.name || "";
    }
    if (status !== "本番") {
      continue;
    }

    // 2. LINE承認有効 が OFF の会員もスキップ
    const lineEnabledProp = mProps["LINE承認有効"];
    const lineEnabled =
      lineEnabledProp && lineEnabledProp.type === "checkbox"
        ? Boolean(lineEnabledProp.checkbox)
        : false;
    if (!lineEnabled) {
      continue;
    }

    // 3. LINEユーザーID を取得
    const lineIdProp = mProps["LINEユーザーID"];
    if (!lineIdProp) continue;

    let value = "";

    // LINEユーザーID がどのタイプでもだいたい拾えるようにしておく
    if (lineIdProp.type === "rich_text" && lineIdProp.rich_text.length > 0) {
      value = lineIdProp.rich_text.map((t) => t.plain_text).join("");
    } else if (lineIdProp.type === "title" && lineIdProp.title.length > 0) {
      value = lineIdProp.title.map((t) => t.plain_text).join("");
    } else if (lineIdProp.type === "formula" && lineIdProp.formula.type === "string") {
      value = lineIdProp.formula.string || "";
    }

    if (value && value.trim()) {
      lineUserIds.push(value.trim());
    }
  }

  // 重複があっても困るので uniq にする
  return Array.from(new Set(lineUserIds));
}

/**
 * LINE に Flex メッセージを送信
 */
async function pushLineMessage(to, flexMessage) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to,
      messages: [flexMessage],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("LINE push error:", res.status, text);
    throw new Error(`LINE push error: ${res.status}`);
  }
}

/**
 * 外部から呼び出されるメイン関数
 *
 * 引数：
 * - approvalPageId: 承認票DB のページID
 */
export async function sendApprovalMessage(approvalPageId) {
  if (!NOTION_API_KEY) {
    throw new Error("NOTION_API_KEY is not set.");
  }
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not set.");
  }

  // 1. 宛先となる LINEユーザーID を取得
  const lineUserIds = await getLineUserIdsFromApprovalPage(approvalPageId);

  if (!lineUserIds.length) {
    console.warn("宛先の LINEユーザーID が見つかりませんでした。");
    throw new Error("No LINE user IDs found for this approval ticket.");
  }

  // 2. 各種URLを組み立て
  const approvalUrl = `${APPROVAL_FORM_BASE_URL}?id=${encodeURIComponent(
    approvalPageId
  )}`;
  const approveUrl = `${APPROVE_URL_BASE}?id=${encodeURIComponent(
    approvalPageId
  )}`;
  const denyUrl = `${DENY_URL_BASE}?id=${encodeURIComponent(approvalPageId)}`;

  // 2.5 承認票DBページに URL を書き込む
  // 承認票DB 必須プロパティ：
  //   送信URL, approveURL, denyURL
  try {
    await notionRequest(`/pages/${approvalPageId}`, "PATCH", {
      properties: {
        送信URL: { url: approvalUrl },
        approveURL: { url: approveUrl },
        denyURL: { url: denyUrl },
      },
    });
  } catch (e) {
    // URL書き込みに失敗しても、LINE送信自体は続行する（ログだけ出す）
    console.error("Failed to update approval URLs on Notion page:", e);
  }

  // 3. Flex メッセージ本体
  const flexMessage = {
    type: "flex",
    altText: "【承認依頼】NPO法人ガレージ都農",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: "承認のお願い",
            weight: "bold",
            size: "md",
          },
          {
            type: "text",
            text: "NPO法人ガレージ都農から承認のお願いです。",
            wrap: true,
            size: "sm",
          },
          {
            type: "text",
            text: "リンク先の画面で内容を確認し、「承認」または「否認」を選んで送信してください。",
            wrap: true,
            size: "xs",
            margin: "md",
          },
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
            height: "md",
            action: {
              type: "uri",
              label: "内容を確認する",
              uri: approvalUrl,
            },
          },
        ],
      },
    },
  };

  // 4. 宛先ごとに送信（条件を満たす会員だけ）
  for (const to of lineUserIds) {
    await pushLineMessage(to, flexMessage);
  }

  return {
    ok: true,
    sentTo: lineUserIds,
  };
}
