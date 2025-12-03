// /api/approve.js
//
// 承認フォーム表示（GET）＋ 承認結果反映（POST）
// - LINEのボタンからブラウザで開く
// - フォームで コメント + 承認/否認（ラジオボタン）を選んで送信
// - 承認票DBの「承認結果」「承認日時」「コメント（表示用）」を更新

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";
const querystring = require("querystring");

// Notion ページ（承認票）のタイトルを取得（表示用）
async function getPageTitle(pageId) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    return null;
  }

  const data = await res.json();
  const props = data.properties || {};
  const nameProp = props["名前"];

  if (
    nameProp &&
    nameProp.type === "title" &&
    Array.isArray(nameProp.title) &&
    nameProp.title.length > 0
  ) {
    return nameProp.title[0].plain_text || "承認票";
  }

  return "承認票";
}

// 承認結果を Notion に反映する
async function updateApproval(pageId, resultKey, commentText) {
  const now = new Date().toISOString();

  // resultKey: "approve" | "deny"
  const resultName = resultKey === "approve" ? "承認" : "否認";

  const body = {
    properties: {
      // セレクトプロパティ「承認結果」に "承認" / "否認" を入れる
      "承認結果": {
        select: { name: resultName },
      },
      // 日付プロパティ「承認日時」に実行時刻を入れる
      "承認日時": {
        date: { start: now },
      },
      // リッチテキストプロパティ「コメント（表示用）」にコメントを入れる
      "コメント（表示用）": {
        rich_text: commentText
          ? [
              {
                type: "text",
                text: {
                  content: commentText,
                },
              },
            ]
          : [],
      },
    },
  };

  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion update failed: ${res.status} ${text}`);
  }
}

// 承認フォーム HTML（GET用）
function renderFormHtml({ pageId, title, presetResult }) {
  const safeTitle = title || "承認依頼";
  const approveChecked = presetResult === "approve" ? "checked" : "";
  const denyChecked = presetResult === "deny" ? "checked" : "";

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta
    name="viewport"
    content="width=device-width,initial-scale=1,viewport-fit=cover"
  />
  <title>${safeTitle} - 承認フォーム</title>
  <style>
    :root {
      color-scheme: light;
    }
    body {
      margin: 0;
      padding: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
        "Helvetica Neue", Arial, sans-serif;
      background-color: #f5f5f5;
      color: #222222;
      line-height: 1.6;
      font-size: 18px;
    }
    .page {
      min-height: 100vh;
      display: flex;
      align-items: stretch;
      justify-content: center;
      padding: 24px 16px;
    }
    .card {
      max-width: 640px;
      width: 100%;
      background-color: #ffffff;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
      padding: 24px 20px 28px;
      box-sizing: border-box;
    }
    .title {
      font-size: 22px;
      font-weight: 700;
      margin: 0 0 8px;
    }
    .subtitle {
      font-size: 15px;
      color: #666666;
      margin: 0 0 20px;
    }
    .section-title {
      font-size: 17px;
      font-weight: 600;
      margin: 20px 0 8px;
    }
    .notice {
      font-size: 15px;
      color: #555555;
      background-color: #f0f4ff;
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 16px;
    }
    textarea {
      width: 100%;
      min-height: 120px;
      font-family: inherit;
      font-size: 17px;
      line-height: 1.6;
      padding: 10px 12px;
      box-sizing: border-box;
      border-radius: 8px;
      border: 1px solid #cccccc;
      resize: vertical;
    }
    textarea:focus {
      outline: none;
      border-color: #2f6fdd;
      box-shadow: 0 0 0 2px rgba(47, 111, 221, 0.2);
    }
    .radio-group {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 6px;
    }
    .radio-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid #dddddd;
    }
    .radio-item input[type="radio"] {
      width: 22px;
      height: 22px;
    }
    .radio-label-main {
      font-size: 18px;
      font-weight: 600;
    }
    .radio-label-sub {
      font-size: 14px;
      color: #666666;
    }
    .radio-approve {
      border-color: #2f6fdd;
      background-color: #f5f8ff;
    }
    .radio-deny {
      background-color: #fafafa;
    }
    .buttons {
      margin-top: 24px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .btn-primary {
      width: 100%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 12px 16px;
      font-size: 18px;
      font-weight: 600;
      border-radius: 999px;
      border: none;
      cursor: pointer;
      background-color: #2f6fdd;
      color: #ffffff;
    }
    .btn-primary:active {
      transform: translateY(1px);
    }
    .helper {
      font-size: 14px;
      color: #666666;
      text-align: center;
    }
    .footer {
      margin-top: 24px;
      font-size: 13px;
      color: #999999;
      text-align: center;
    }
    @media (min-width: 768px) {
      body {
        font-size: 18px;
      }
    }
  </style>
</head>
<body>
<div class="page">
  <div class="card">
    <h1 class="title">${safeTitle}</h1>
    <p class="subtitle">内容をご確認のうえ、「承認」または「否認」を選択し、コメントがあれば入力して「送信」してください。</p>

    <div class="notice">
      <strong>ご案内</strong><br />
      議案の詳細や添付資料は、別途お送りしている資料・Notionページをご確認ください。
    </div>

    <form method="POST" action="/api/approve">
      <input type="hidden" name="id" value="${pageId}" />

      <h2 class="section-title">コメント（任意）</h2>
      <textarea
        name="comment"
        placeholder="例）承認します。次回からは資料送付の期限を前倒しでお願いします。"
      ></textarea>

      <h2 class="section-title">承認・否認の選択（必須）</h2>
      <div class="radio-group">
        <label class="radio-item radio-approve">
          <input type="radio" name="result" value="approve" ${approveChecked} />
          <div>
            <div class="radio-label-main">承認する</div>
            <div class="radio-label-sub">この議案の内容に同意します。</div>
          </div>
        </label>

        <label class="radio-item radio-deny">
          <input type="radio" name="result" value="deny" ${denyChecked} />
          <div>
            <div class="radio-label-main">否認する</div>
            <div class="radio-label-sub">この内容では承認できません。</div>
          </div>
        </label>
      </div>

      <div class="buttons">
        <button type="submit" class="btn-primary">送信</button>
        <div class="helper">※「承認」または「否認」を選んでから送信してください。</div>
      </div>
    </form>

    <div class="footer">
      この画面を閉じるときは、端末の「戻る」ボタンやブラウザのタブを閉じてください。
    </div>
  </div>
</div>
</body>
</html>`;
}

// 完了画面 HTML（POST後）
function renderResultHtml({ title, resultKey, comment }) {
  const safeTitle = title || "承認票";
  const isApprove = resultKey === "approve";
  const resultLabel = isApprove ? "承認" : "否認";
  const resultColor = isApprove ? "#2f6fdd" : "#c0392b";

  const commentBlock = comment
    ? `<div class="section-title">送信されたコメント</div>
       <div class="comment-box">${escapeHtml(comment)}</div>`
    : `<div class="section-title">コメント</div>
       <div class="comment-box comment-empty">コメントは送信されませんでした。</div>`;

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta
    name="viewport"
    content="width=device-width,initial-scale=1,viewport-fit=cover"
  />
  <title>${safeTitle} - 処理完了</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
        "Helvetica Neue", Arial, sans-serif;
      background-color: #f5f5f5;
      color: #222222;
      line-height: 1.6;
      font-size: 18px;
    }
    .page {
      min-height: 100vh;
      display: flex;
      align-items: stretch;
      justify-content: center;
      padding: 24px 16px;
    }
    .card {
      max-width: 640px;
      width: 100%;
      background-color: #ffffff;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
      padding: 24px 20px 28px;
      box-sizing: border-box;
    }
    .title {
      font-size: 22px;
      font-weight: 700;
      margin: 0 0 8px;
    }
    .result-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 15px;
      font-weight: 600;
      color: #ffffff;
      background-color: ${resultColor};
      margin-bottom: 12px;
    }
    .section-title {
      font-size: 17px;
      font-weight: 600;
      margin: 18px 0 8px;
    }
    .comment-box {
      border-radius: 8px;
      border: 1px solid #dddddd;
      padding: 10px 12px;
      background-color: #fafafa;
      white-space: pre-wrap;
    }
    .comment-empty {
      color: #777777;
      font-size: 15px;
    }
    .footer {
      margin-top: 24px;
      font-size: 14px;
      color: #666666;
      text-align: center;
    }
  </style>
</head>
<body>
<div class="page">
  <div class="card">
    <div class="result-chip">${resultLabel} が登録されました</div>
    <h1 class="title">${safeTitle}</h1>

    ${commentBlock}

    <div class="footer">
      画面を閉じても処理は完了しています。<br/>
      必要であれば、Notion 上の承認票で内容をご確認ください。
    </div>
  </div>
</div>
</body>
</html>`;
}

// 簡易エスケープ
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = async (req, res) => {
  const { method } = req;

  if (method === "GET") {
    const { id, result } = req.query || {};
    if (!id) {
      res.status(400).send("Missing required parameter: id");
      return;
    }

    try {
      const title = await getPageTitle(id);
      const html = renderFormHtml({
        pageId: id,
        title,
        // もしクエリで result=approve/deny が来ていれば事前選択する
        presetResult: result === "approve" || result === "deny" ? result : null,
      });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(html);
    } catch (e) {
      console.error(e);
      res.status(500).send("承認フォームの表示中にエラーが発生しました。");
    }
    return;
  }

  if (method === "POST") {
    let body = req.body || {};

    // Vercel環境で body が文字列の場合に対応
    if (typeof body === "string") {
      body = querystring.parse(body);
    }

    const pageId = body.id;
    const resultKey = body.result;
    const comment = body.comment || "";

    if (!pageId) {
      res.status(400).send("Missing required parameter: id");
      return;
    }
    if (resultKey !== "approve" && resultKey !== "deny") {
      res
        .status(400)
        .send("承認または否認のいずれかを選択してください。（result）");
      return;
    }

    try {
      await updateApproval(pageId, resultKey, comment);
      const title = await getPageTitle(pageId);
      const html = renderResultHtml({
        title,
        resultKey,
        comment,
      });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(html);
    } catch (e) {
      console.error(e);
      res
        .status(500)
        .send("承認結果の登録中にエラーが発生しました。時間をおいて再度お試しください。");
    }
    return;
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).send("Method Not Allowed");
};
