// api/cron.js
// Garage Tsuno 承認システム用 Cron（5分ごとに実行）

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET || null;

// Notion DB ID
const GIANDAN_DB_ID = "2ab9f7abb33d80dfaadcc347803768e8"; // 議案DB
const APPROVAL_DB_ID = "2ba9f7abb33d806e92ccded4f2149d86"; // 承認票DB（念のため保持）

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_HEADERS = {
  Authorization: `Bearer ${NOTION_API_KEY}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

// ---------- 共通ヘルパー ----------

async function callNotion(path, options = {}) {
  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    ...options,
    headers: { ...NOTION_HEADERS, ...(options.headers || {}) },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Notion API error:", res.status, text);
    throw new Error(`Notion API error ${res.status}`);
  }
  return res.json();
}

function getPlainFromTitle(prop) {
  if (!prop || !prop.title) return "";
  return prop.title.map((t) => t.plain_text).join("");
}

function getPlainFromRich(prop) {
  if (!prop || !prop.rich_text) return "";
  return prop.rich_text.map((t) => t.plain_text).join("");
}

function getUrlFromUrlOrRich(prop) {
  if (!prop) return "";
  if (prop.url) return prop.url;
  return getPlainFromRich(prop);
}

function getFileUrls(prop) {
  if (!prop || !prop.files) return [];
  return prop.files
    .map((f) => (f.external && f.external.url) || (f.file && f.file.url))
    .filter(Boolean);
}

async function sendLineMessage(to, text) {
  if (!to) {
    console.warn("LINE: userId が空なので送信スキップ");
    return;
  }

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to,
      messages: [
        {
          type: "text",
          text,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("LINE API error:", res.status, body);
  }
}

// ---------- メイン処理 ----------

module.exports = async (req, res) => {
  // Cron 用の簡易認証（任意）
  if (CRON_SECRET) {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${CRON_SECRET}`) {
      res.statusCode = 401;
      return res.end("Unauthorized");
    }
  }

  try {
    // 1. 議案DBから「送信ステータス」が未送信のものを取得
    const giandanResp = await callNotion(`/databases/${GIANDAN_DB_ID}/query`, {
      method: "POST",
      body: JSON.stringify({
        filter: {
          or: [
            {
              property: "送信ステータス",
              select: { equals: "未送信" },
            },
            {
              property: "送信ステータス",
              select: { is_empty: true },
            },
          ],
        },
        page_size: 50,
      }),
    });

    const targets = giandanResp.results || [];
    console.log("cron: targets =", targets.length);

    if (targets.length === 0) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, message: "no new giandan" }));
    }

    for (const page of targets) {
      const props = page.properties;

      const title = getPlainFromTitle(props["名前"]);
      const body = getPlainFromRich(props["内容（説明）"]);
      const fileUrls = getFileUrls(props["添付資料"]);

      // 関連する承認票を取得（承認票DB リレーション）
      const relationProp = props["承認票DB"];
      const related = (relationProp && relationProp.relation) || [];

      if (related.length === 0) {
        console.warn("cron: 承認票DB リレーションなし:", page.id);
        continue;
      }

      // 各承認票ごとに LINE 送信
      for (const rel of related) {
        const approvalPageId = rel.id;

        // 承認票ページ取得
        const approvalPage = await callNotion(`/pages/${approvalPageId}`, {
          method: "GET",
        });
        const aProps = approvalPage.properties;

        // 承認者（会員DBへのリレーション）取得
        const approverRel = aProps["承認者"];
        const approverList = (approverRel && approverRel.relation) || [];
        if (approverList.length === 0) {
          console.warn("cron: 承認者 リレーションなし:", approvalPageId);
          continue;
        }
        const memberPageId = approverList[0].id;

        // 会員DB側から LINEユーザーID を取得
        const memberPage = await callNotion(`/pages/${memberPageId}`, {
          method: "GET",
        });
        const mProps = memberPage.properties;
        const memberName = getPlainFromTitle(mProps["氏名"]) || "";
        const lineUserId = getPlainFromRich(mProps["LINEユーザーID"]);

        if (!lineUserId) {
          console.warn(
            "cron: LINEユーザーID 未設定:",
            memberName,
            memberPageId
          );
          continue;
        }

        const approveUrl = getUrlFromUrlOrRich(aProps["approveURL"]);
        const denyUrl = getUrlFromUrlOrRich(aProps["denyURL"]);

        // メッセージ組み立て
        const lines = [];

        lines.push(`${memberName} さん`);
        lines.push("");
        lines.push("【Garage Tsuno 発議のご確認】");
        lines.push("");
        lines.push("案件名：");
        lines.push(title || "（タイトルなし）");
        lines.push("");

        if (body) {
          lines.push("内容：");
          lines.push(body);
          lines.push("");
        }

        if (fileUrls.length > 0) {
          lines.push("添付資料：");
          fileUrls.forEach((u, i) => {
            lines.push(`・ファイル${i + 1}: ${u}`);
          });
          lines.push("");
        }

        lines.push("承認・否認はこちらから：");
        if (approveUrl) lines.push(`承認：${approveUrl}`);
        if (denyUrl) lines.push(`否認：${denyUrl}`);

        const messageText = lines.join("\n");

        console.log("cron: send to", memberName, lineUserId);
        await sendLineMessage(lineUserId, messageText);
      }

      // 3. 議案側の 送信ステータス を「送信済」に更新
      await callNotion(`/pages/${page.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            送信ステータス: {
              select: { name: "送信済" },
            },
          },
        }),
      });
    }

    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, sent: targets.length }));
  } catch (e) {
    console.error("cron error:", e);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
