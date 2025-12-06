// /api/approve.js
// 承認票に「承認」を1回だけ記録するAPI
// - GET : 承認フォーム or 「回答済み」表示
// - POST: 未回答のときだけ 承認結果・承認日時・コメント を書き込む

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_API_KEY}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function getTicketPage(pageId) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "GET",
    headers: notionHeaders(),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error("Notion getPage error:", text);
    throw new Error("承認票の取得に失敗しました。");
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

function renderHtml({ title, message, note, showForm, id }) {
  // シンプルなHTML。UTF-8固定。
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 24px; line-height: 1.6; }
    .box { max-width: 520px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; padding: 20px; }
    h1 { font-size: 1.2rem; margin-top: 0; }
    textarea { width: 100%; min-height: 120px; }
    button { padding: 8px 16px; border-radius: 4px; border: none; cursor: pointer; }
    button.approve { background: #2e7d32; color: #fff; }
    .message { margin: 12px 0; color: #333; }
    .note { font-size: 0.85rem; margin-top: 12px; }
    .note.warn { color: #d32f2f; }
    .note.info { color: #666; }
  </style>
</head>
<body>
  <div class="box">
    <h1>${title}</h1>
    <div class="message">${message}</div>
    ${
      showForm
        ? `<form method="POST" action="/api/approve?id=${id}">
            <label for="comment">コメント（任意）</label><br />
            <textarea id="comment" name="comment" placeholder="コメントがあればご記入ください"></textarea>
            <div style="margin-top: 16px;">
              <button type="submit" class="approve">承認を送信する</button>
            </div>
            <p class="note info">※ この承認票には 1 度だけ回答できます。送信後の取り消し・修正はできません。</p>
          </form>`
        : ""
    }
    ${
      note
        ? `<p class="note ${note.type === "warn" ? "warn" : "info"}">${note.text}</p>`
        : ""
    }
  </div>
</body>
</html>`;
}

// フォームの x-www-form-urlencoded をパース
async function parseFormBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const params = {};
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const [k, v] = pair.split("=");
    const key = decodeURIComponent(k.replace(/\+/g, " "));
    const val = decodeURIComponent((v || "").replace(/\+/g, " "));
    params[key] = val;
  }
  return params;
}

module.exports = async (req, res) => {
  const { id } = req.query;

  if (!id) {
    res.statusCode = 400;
    return res.end("id が指定されていません。");
  }

  if (!NOTION_API_KEY) {
    res.statusCode = 500;
    return res.end("サーバー設定エラー：NOTION_API_KEY が未設定です。");
  }

  try {
    if (req.method === "GET") {
      // 承認フォーム表示 or 回答済み表示
      const page = await getTicketPage(id);
      const props = page.properties || {};

      const titleProp = props["名前"] || props["タイトル"];
      const ticketTitle = extractText(titleProp) || "承認票";

      const resultProp = props["承認結果"];
      const already =
        resultProp && resultProp.select && resultProp.select.name
          ? resultProp.select.name
          : null;

      if (already) {
        // ▼ 2回目以降にだけ表示したいメッセージ
        const html = renderHtml({
          title: ticketTitle,
          message: `この承認票はすでに「${already}」として登録されています。`,
          note: {
            type: "warn",
            text: "送信内容の変更や再回答はできません。必要な場合は事務局までご連絡ください。",
          },
          showForm: false,
          id,
        });
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.status(200).end(html);
      }

      // ▼ 初回アクセス（未回答）のみ、フォームを表示
      const html = renderHtml({
        title: ticketTitle,
        message:
          "この議案に「承認」として回答します。内容を確認のうえ、必要であればコメントを入力して送信してください。",
        note: null,
        showForm: true,
        id,
      });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).end(html);
    }

    if (req.method === "POST") {
      // 承認実行（未回答のときだけ）
      const page = await getTicketPage(id);
      const props = page.properties || {};

      const resultProp = props["承認結果"];
      const already =
        resultProp && resultProp.select && resultProp.select.name
          ? resultProp.select.name
          : null;

      const titleProp = props["名前"] || props["タイトル"];
      const ticketTitle = extractText(titleProp) || "承認票";

      if (already) {
        // ▼ 既に結果が入っている場合は更新せず注意メッセージのみ
        const html = renderHtml({
          title: ticketTitle,
          message: `この承認票はすでに「${already}」として登録されています。`,
          note: {
            type: "warn",
            text: "送信内容の変更や再回答はできません。必要な場合は事務局までご連絡ください。",
          },
          showForm: false,
          id,
        });
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.status(200).end(html);
      }

      // ▼ ここは「初回の POST」だけ通る
      const form = await parseFormBody(req);
      const comment = form.comment || "";
      const now = new Date().toISOString();

      const body = {
        properties: {
          "承認結果": {
            select: { name: "承認" },
          },
          "承認日時": {
            date: { start: now },
          },
          "コメント": {
            rich_text: comment
              ? [
                  {
                    text: { content: comment },
                  },
                ]
              : [],
          },
        },
      };

      const updateRes = await fetch(`https://api.notion.com/v1/pages/${id}`, {
        method: "PATCH",
        headers: notionHeaders(),
        body: JSON.stringify(body),
      });

      const text = await updateRes.text();
      if (!updateRes.ok) {
        console.error("Notion update (approve) error:", text);
        res.statusCode = 500;
        return res.end(
          "承認の登録に失敗しました。時間をおいて再度お試しください。"
        );
      }

      // ▼ 初回の完了画面：ここでは「すでに承認済み」系の文言は出さない
      const html = renderHtml({
        title: ticketTitle,
        message: "承認を受け付けました。ご回答ありがとうございます。",
        note: {
          type: "info",
          text: "この画面は閉じていただいて構いません。",
        },
        showForm: false,
        id,
      });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).end(html);
    }

    res.setHeader("Allow", "GET, POST");
    res.statusCode = 405;
    return res.end("Method Not Allowed");
  } catch (err) {
    console.error("approve.js error:", err);
    res.statusCode = 500;
    return res.end("内部エラーが発生しました。時間をおいて再度お試しください。");
  }
};
