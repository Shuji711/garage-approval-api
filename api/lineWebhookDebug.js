// api/lineWebhookDebug.js
// LINE公式アカウント Webhook 本番版
// 役割：
//  - テキストメッセージ  → 承認票DB の「コメント」に追記（発言者名付き）
//  - ポストバック（承認する / 否認する） → 確認用Flexメッセージを返信
//  - ポストバック（キャンセル） → キャンセルメッセージを返信

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";
const APPROVAL_DB_ID = process.env.APPROVAL_DB_ID; // 承認票DB のIDを環境変数に設定しておく
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const qs = require("querystring");

// 汎用 Notion 呼び出し
async function notionFetch(path, options = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API error ${res.status}: ${text}`);
  }
  return res.json();
}

// 承認票DB から「指定LINEユーザーの、承認結果が空のレコード」を1件取得
async function findLatestOpenTicketForLineUser(lineUserId) {
  if (!APPROVAL_DB_ID) {
    console.error("APPROVAL_DB_ID is not set");
    return null;
  }

  const body = {
    filter: {
      and: [
        {
          property: "LINEユーザーID文字列", // 承認票DB側に rich_text プロパティを作成しておく
          rich_text: {
            contains: lineUserId,
          },
        },
        {
          property: "承認結果",
          select: {
            is_empty: true,
          },
        },
      ],
    },
    // ソートは省略（1人1件運用を前提）
  };

  try {
    const data = await notionFetch(`/databases/${APPROVAL_DB_ID}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    const page = data.results && data.results[0];
    return page || null;
  } catch (e) {
    console.error("findLatestOpenTicketForLineUser error:", e);
    return null;
  }
}

// コメントを承認票DBの「コメント」プロパティに追記
async function appendCommentToTicket(pageId, lineUserId, text) {
  // 発言者名は LINE プロフィールから取得
  const profileRes = await fetch(
    `https://api.line.me/v2/bot/profile/${lineUserId}`,
    {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );

  let displayName = "不明";
  if (profileRes.ok) {
    const profile = await profileRes.json();
    if (profile.displayName) {
      displayName = profile.displayName;
    }
  }

  const commentLine = `（${displayName}）${text}`;

  // 既存コメント取得
  const page = await notionFetch(`/pages/${pageId}`);
  const props = page.properties || {};
  const commentProp = props["コメント"];

  let existingText = "";
  if (commentProp && commentProp.type === "rich_text") {
    existingText =
      commentProp.rich_text?.map((r) => r.plain_text || "").join("") || "";
  }

  const newText =
    existingText && existingText.trim().length > 0
      ? `${existingText}\n${commentLine}`
      : commentLine;

  // コメントを書き戻し
  await notionFetch(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        コメント: {
          rich_text: [
            {
              type: "text",
              text: { content: newText },
            },
          ],
        },
      },
    }),
  });
}

// LINE返信（テキスト）
async function replyText(replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [
        {
          type: "text",
          text,
        },
      ],
    }),
  });
}

// LINE返信（Flex メッセージ）
async function replyFlex(replyToken, altText, contents) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [
        {
          type: "flex",
          altText,
          contents,
        },
      ],
    }),
  });
}

// 承認・否認の確認用 Flex メッセージ生成
function buildConfirmBubble({ title, commentText, resultLabel, pageId }) {
  const confirmUrl =
    resultLabel === "承認"
      ? `https://approval.garagetsuno.org/approve?id=${pageId}`
      : `https://approval.garagetsuno.org/deny?id=${pageId}`;

  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        {
          type: "text",
          text: "承認内容の確認",
          size: "lg",
          weight: "bold",
          align: "center",
        },
        {
          type: "box",
          layout: "vertical",
          margin: "md",
          spacing: "xs",
          contents: [
            {
              type: "text",
              text: "議案",
              size: "sm",
              weight: "bold",
            },
            {
              type: "text",
              text: title || "（タイトル未設定）",
              size: "sm",
              wrap: true,
            },
          ],
        },
        {
          type: "box",
          layout: "vertical",
          margin: "md",
          spacing: "xs",
          contents: [
            {
              type: "text",
              text: "コメント",
              size: "sm",
              weight: "bold",
            },
            {
              type: "text",
              text: commentText || "（コメントなし）",
              size: "sm",
              wrap: true,
            },
          ],
        },
        {
          type: "box",
          layout: "vertical",
          margin: "md",
          spacing: "xs",
          contents: [
            {
              type: "text",
              text: "結果",
              size: "sm",
              weight: "bold",
            },
            {
              type: "text",
              text: resultLabel,
              size: "sm",
            },
          ],
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
          height: "sm",
          action: {
            type: "uri",
            label: "この内容で確定する",
            uri: confirmUrl,
          },
        },
        {
          type: "button",
          style: "secondary",
          height: "sm",
          action: {
            type: "postback",
            label: "やり直す",
            data: qs.stringify({
              action: "cancel",
              pageId,
            }),
          },
        },
      ],
    },
  };
}

module.exports = async function handler(req, res) {
  const body =
    typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

  console.log("LINE Webhook:", JSON.stringify(body, null, 2));

  const events = body.events || [];

  for (const event of events) {
    try {
      // 1) テキストメッセージ → コメント追記
      if (event.type === "message" && event.message?.type === "text") {
        const userId = event.source?.userId;
        const text = event.message.text;
        const replyToken = event.replyToken;

        if (!userId) {
          continue;
        }

        const ticket = await findLatestOpenTicketForLineUser(userId);
        if (!ticket) {
          // 対象の承認票がない場合は軽く案内
          await replyText(
            replyToken,
            "コメントを紐づける承認票が見つかりませんでした。"
          );
          continue;
        }

        await appendCommentToTicket(ticket.id, userId, text);
        await replyText(replyToken, "コメントを受け付けました。");

        continue;
      }

      // 2) ポストバック（承認・否認・キャンセル）
      if (event.type === "postback") {
        const data = qs.parse(event.postback.data || "");
        const action = data.action;
        const pageId = data.pageId;
        const replyToken = event.replyToken;

        if (!action) continue;

        // 承認・否認 選択 → 確認カードを表示
        if (action === "select" && pageId) {
          const result = data.result === "deny" ? "否認" : "承認";

          const page = await notionFetch(`/pages/${pageId}`);
          const props = page.properties || {};

          const title =
            props["名前"]?.title?.[0]?.plain_text ||
            props["タイトル"]?.title?.[0]?.plain_text ||
            "承認票";

          const commentProp = props["コメント"];
          const commentText =
            commentProp?.rich_text
              ?.map((r) => r.plain_text || "")
              .join("") || "";

          const bubble = buildConfirmBubble({
            title,
            commentText,
            resultLabel: result,
            pageId,
          });

          await replyFlex(replyToken, "承認内容の確認", bubble);
          continue;
        }

        // キャンセル → 文言だけ返信
        if (action === "cancel") {
          await replyText(
            replyToken,
            "操作をキャンセルしました。コメントや結果を修正して、もう一度ボタンを押してください。"
          );
          continue;
        }
      }
    } catch (e) {
      console.error("LINE Webhook handler error:", e);
      // エラー時も 200 を返して LINE 側のリトライループを防ぐ
    }
  }

  res.status(200).json({ ok: true });
};
