// /api/approve.js
//
// 承認フォーム表示（GET）＋ 承認結果反映（POST）
// - LINEのボタンからブラウザで開く
// - フォームで コメント + 承認/否認（ラジオボタン）を選んで送信
// - 承認票DBの「承認結果」「承認日時」、あればコメント系プロパティを更新
// - 画面上部に「議案」「内容」「発議者」「承認期限」「添付資料」を表示

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";
const querystring = require("querystring");

// ---- 共通ユーティリティ ----

function formatJpDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  const w = ["日", "月", "火", "水", "木", "金", "土"];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${
    w[d.getDay()]
  }）`;
}

function deriveAttachmentLabel(url, index) {
  try {
    // クエリ・フラグメントを除去
    const cleaned = url.split(/[?#]/)[0];
    let name = cleaned.split("/").pop() || "";

    // Google Drive 等で /view で終わる場合はファイル名にできないのでフォールバック
    if (name.toLowerCase() === "view") {
      return `添付資料${index}`;
    }

    const decoded = decodeURIComponent(name);
    if (decoded) return decoded;
  } catch (e) {
    // noop
  }
  return `添付資料${index}`;
}

// 簡易エスケープ
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- Notion から承認票+議案情報を取得 ----

async function fetchApprovalContext(pageId) {
  let title = "承認票";
  let issueNo = "";
  let description = "";
  let proposerNames = "";
  let deadlineText = "";
  const attachments = [];

  // 承認票ページ
  const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  });

  if (!pageRes.ok) {
    const txt = await pageRes.text();
    throw new Error(
      `Failed to fetch approval page: ${pageRes.status} ${
        txt || pageRes.statusText
      }`
    );
  }

  const pageData = await pageRes.json();
  const aProps = pageData.properties || {};

  // 承認票タイトル
  const aNameProp = aProps["名前"] || aProps["タイトル"];
  if (
    aNameProp &&
    aNameProp.type === "title" &&
    Array.isArray(aNameProp.title) &&
    aNameProp.title.length > 0
  ) {
    title = aNameProp.title[0].plain_text || title;
  }

  // 関連する議案ページ
  const proposalRel = aProps["議案"]?.relation || [];
  const proposalPageId = proposalRel[0]?.id;

  if (proposalPageId) {
    try {
      const proposalRes = await fetch(
        `https://api.notion.com/v1/pages/${proposalPageId}`,
        {
          headers: {
            Authorization: `Bearer ${NOTION_API_KEY}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
        }
      );

      if (proposalRes.ok) {
        const proposalData = await proposalRes.json();
        const pProps = proposalData.properties || {};

        // 議案タイトル（あればこちらを優先）
        const pTitleProp = pProps["タイトル"] || pProps["名前"];
        if (
          pTitleProp &&
          pTitleProp.type === "title" &&
          Array.isArray(pTitleProp.title) &&
          pTitleProp.title.length > 0
        ) {
          title = pTitleProp.title[0].plain_text || title;
        }

        // 議案番号
        const issueProp =
          pProps["議案番号フォーミュラ"] ||
          pProps["議案番号"] ||
          pProps["議案番号（自動）"];

        issueNo =
          issueProp?.formula?.string ??
          issueProp?.rich_text?.[0]?.plain_text ??
          "";

        // 内容（説明） 全文
        const descSource = pProps["内容（説明）"]?.rich_text;
        if (Array.isArray(descSource) && descSource.length > 0) {
          description = descSource.map((r) => r.plain_text || "").join("");
        }

        // 発議者（会員DBへのリレーション想定）
        const proposerRel = pProps["発議者"]?.relation || [];
        const proposerList = [];
        for (const rel of proposerRel) {
          const memberId = rel.id;
          try {
            const memberRes = await fetch(
              `https://api.notion.com/v1/pages/${memberId}`,
              {
                headers: {
                  Authorization: `Bearer ${NOTION_API_KEY}`,
                  "Notion-Version": NOTION_VERSION,
                  "Content-Type": "application/json",
                },
              }
            );
            if (!memberRes.ok) continue;
            const memberData = await memberRes.json();
            const mProps = memberData.properties || {};
            const mNameProp =
              mProps["氏名"] || mProps["名前"] || mProps["タイトル"];
            let memberName = "";
            if (
              mNameProp &&
              mNameProp.type === "title" &&
              Array.isArray(mNameProp.title) &&
              mNameProp.title.length > 0
            ) {
              memberName = mNameProp.title[0].plain_text || "";
            }
            if (memberName) proposerList.push(memberName);
          } catch (e) {
            console.error("Fetch proposer failed:", e);
          }
        }
        if (proposerList.length > 0) {
          proposerNames = proposerList.join("、");
        }

        // 承認期限（日付プロパティ）
        const deadlineProp =
          pProps["承認期限"]?.date || pProps["期限"]?.date || null;
        const deadlineStart = deadlineProp?.start;
        if (deadlineStart) {
          deadlineText = formatJpDate(deadlineStart);
        }

        // 添付資料 URL（「添付リンク」で始まるURLプロパティをすべて拾う）
        let attachIndex = 1;
        for (const [name, prop] of Object.entries(pProps)) {
          if (!name.startsWith("添付リンク")) continue;
          if (prop && prop.type === "url" && prop.url) {
            const url = prop.url;
            const label = deriveAttachmentLabel(url, attachIndex++);
            attachments.push({ url, label });
          }
        }
      }
    } catch (e) {
      console.error("Fetch proposal page failed:", e);
    }
  }

  return {
    title,
    issueNo,
    description,
    proposerNames,
    deadlineText,
    attachments,
  };
}

// ---- 承認結果を Notion に反映 ----
// コメント用プロパティ名は動的に判定（存在しない名前では書きに行かない）

async function updateApproval(pageId, resultKey, commentText) {
  const now = new Date().toISOString();

  // 承認票ページを取得して、存在するプロパティ名を確認
  const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  });

  if (!pageRes.ok) {
    const txt = await pageRes.text();
    throw new Error(
      `Failed to fetch page for update: ${pageRes.status} ${
        txt || pageRes.statusText
      }`
    );
  }

  const pageData = await pageRes.json();
  const props = pageData.properties || {};

  // コメント系プロパティ候補
  const candidateNames = ["コメント（表示用）", "コメント", "コメント（表示）"];

  let commentPropName = null;
  for (const name of candidateNames) {
    if (props[name] && props[name].type === "rich_text") {
      commentPropName = name;
      break;
    }
  }

  // 承認結果・承認日時 が無いと困るので存在チェック
  if (!props["承認結果"] || props["承認結果"].type !== "select") {
    throw new Error('Notion page is missing expected property: "承認結果"');
  }
  if (!props["承認日時"] || props["承認日時"].type !== "date") {
    throw new Error('Notion page is missing expected property: "承認日時"');
  }

  // resultKey: "approve" | "deny"
  const resultName = resultKey === "approve" ? "承認" : "否認";

  const updateProps = {
    承認結果: {
      select: { name: resultName },
    },
    承認日時: {
      date: { start: now },
    },
  };

  // コメントプロパティがある場合だけ追加
  if (commentPropName) {
    updateProps[commentPropName] = {
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
    };
  }

  const body = { properties: updateProps };

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

// ---- 承認フォーム HTML（GET） ----

function renderFormHtml({
  pageId,
  title,
  issueNo,
  description,
  proposerNames,
  deadlineText,
  attachments,
  presetResult,
}) {
  const agendaTitle = issueNo ? `${issueNo}　${title}` : title || "承認依頼";
  const approveChecked = presetResult === "approve" ? "checked" : "";
  const denyChecked = presetResult === "deny" ? "checked" : "";
  const safeDescription =
    description ||
    "（内容が登録されていません。必要に応じて担当者へご確認ください。）";
  const proposerText = proposerNames || "（発議者情報が登録されていません）";
  const deadlineTextDisplay = deadlineText || "（期限の指定はありません）";

  let attachmentsHtml = "";
  if (attachments && attachments.length > 0) {
    const items = attachments
      .map(
        (a) =>
          `<li class="attach-item"><a href="${a.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(
            a.label
          )}</a></li>`
      )
      .join("");
    attachmentsHtml = `
      <div class="section-title">添付資料</div>
      <ul class="attach-list">
        ${items}
      </ul>
    `;
  }

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta
    name="viewport"
    content="width=device-width,initial-scale=1,viewport-fit=cover"
  />
  <title>${agendaTitle} - 承認フォーム</title>
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
      max-width: 720px;
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
    .info-box {
      border-radius: 10px;
      border: 1px solid #dddddd;
      background-color: #fafafa;
      padding: 12px 14px;
      font-size: 16px;
    }
    .info-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 6px;
    }
    .info-label {
      min-width: 72px;
      font-weight: 600;
      color: #555555;
    }
    .info-value {
      flex: 1;
    }
    .text-box {
      border-radius: 10px;
      border: 1px solid #dddddd;
      background-color: #ffffff;
      padding: 12px 14px;
      font-size: 16px;
      white-space: pre-wrap;
    }
    .attach-list {
      margin: 0;
      padding-left: 20px;
      list-style: disc;
      font-size: 16px;
    }
    .attach-item + .attach-item {
      margin-top: 4px;
    }
    .attach-list a {
      color: #2f6fdd;
      text-decoration: underline;
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
    <h1 class="title">${agendaTitle}</h1>
    <p class="subtitle">内容をご確認のうえ、「承認」または「否認」を選択し、コメントがあれば入力して「送信」してください。</p>

    <div class="section-title">議案</div>
    <div class="info-box">
      <div class="info-row">
        <div class="info-label">議案名</div>
        <div class="info-value">${escapeHtml(title)}</div>
      </div>
      <div class="info-row">
        <div class="info-label">議案番号</div>
        <div class="info-value">${issueNo ? escapeHtml(issueNo) : "（未設定）"}</div>
      </div>
    </div>

    <div class="section-title">発議者</div>
    <div class="info-box">
      ${escapeHtml(proposerText)}
    </div>

    <div class="section-title">承認期限</div>
    <div class="info-box">
      ${escapeHtml(deadlineTextDisplay)}
    </div>

    <div class="section-title">内容</div>
    <div class="text-box">
      ${escapeHtml(safeDescription)}
    </div>

    ${attachmentsHtml}

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
  </div>
</div>
</body>
</html>`;
}

// ---- 完了画面 HTML（POST） ----

function renderResultHtml({ title, issueNo, resultKey, comment }) {
  const agendaTitle = issueNo ? `${issueNo}　${title}` : title || "承認票";
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
  <title>${agendaTitle} - 処理完了</title>
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
      max-width: 720px;
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
    <h1 class="title">${agendaTitle}</h1>

    ${commentBlock}

    <div class="footer">
      この画面を閉じても処理は完了しています。<br/>
      必要であれば、Notion 上の承認票で内容をご確認ください。
    </div>
  </div>
</div>
</body>
</html>`;
}

// ---- エンドポイント本体 ----

module.exports = async (req, res) => {
  const { method } = req;

  if (method === "GET") {
    const { id, result } = req.query || {};
    if (!id) {
      res.status(400).send("Missing required parameter: id");
      return;
    }

    try {
      const ctx = await fetchApprovalContext(id);
      const html = renderFormHtml({
        pageId: id,
        ...ctx,
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
      const ctx = await fetchApprovalContext(pageId);
      await updateApproval(pageId, resultKey, comment);
      const html = renderResultHtml({
        ...ctx,
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
