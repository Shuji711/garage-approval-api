// api/cron.js

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// 理事3名それぞれの LINE ユーザーID
const LINE_USER_ID_ANDO = process.env.LINE_USER_ID_ANDO;
const LINE_USER_ID_HARUKI = process.env.LINE_USER_ID_HARUKI;
const LINE_USER_ID_KAWANO = process.env.LINE_USER_ID_KAWANO;

// Notion DB ID（固定）
const GIANDAN_DB_ID = "2ab9f7abb33d80dfaadcc347803768e8"; // 議案DB
const APPROVAL_DB_ID = "2ba9f7abb33d806e92ccded4f2149d86"; // 承認票DB

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_HEADERS = {
  "Authorization": `Bearer ${NOTION_API_KEY}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

// ---- ヘルパー ----

function getPlainTextFromTitle(prop) {
  if (!prop || !prop.title || prop.title.length === 0) return "";
  return prop.title.map(t => t.plain_text).join("");
}

function getPlainTextFromRich(prop) {
  if (!prop || !prop.rich_text || prop.rich_text.length === 0) return "";
  return prop.rich_text.map(t => t.plain_text).join("");
}

function getFileUrls(prop) {
  if (!prop || !prop.files) return [];
  return prop.files
    .map(f => (f.external && f.external.url) || (f.file && f.file.url))
    .filter(Boolean);
}

function getLineUserIdByApproverName(name) {
  if (!name) return null;
  if (name.includes("安藤")) return LINE_USER_ID_ANDO || null;
  if (name.includes("春木")) return LINE_USER_ID_HARUKI || null;
  if (name.includes("志帆") || name.includes("河野")) return LINE_USER_ID_KAWANO || null;
  return null;
}

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

async function sendLineMessage(to, text) {
  if (!to) return;
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
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
    const t = await res.text();
    console.error("LINE API error:", res.status, t);
  }
}

// ---- メイン処理 ----

module.exports = async (req, res) => {
  // Vercel Cron 以外から叩かれた場合の簡易チェック（任意）
  if (process.env.CRON_SECRET) {
    const auth = req.headers["authorization"] || "";
    const expected = `Bearer ${process.env.CRON_SECRET}`;
    if (auth !== expected) {
      res.statusCode = 401;
      return res.end("Unauthorized");
    }
  }

  try {
    // 1. 議案DBを取得（とりあえず最大50件）
    const giandanResp = await callNotion(`/databases/${GIANDAN_DB_ID}/query`, {
      method: "POST",
      body: JSON.stringify({ page_size: 50 }),
    });

    const targets = giandanResp.results.filter(page => {
      const prop = page.properties["送信ステータス"];
      if (!prop || !prop.select) return true; // 空欄は未送信扱い
      return prop.select.name === "未送信";
    });

    if (targets.length === 0) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, message: "no new items" }));
    }

    for (const page of targets) {
      const props = page.properties;

      const title = getPlainTextFromTitle(props["名前"]);
      const body = getPlainTextFromRich(props["内容（説明）"]);
      const fileUrls = getFileUrls(props["添付資料"]);

      // 関連する承認票（3件）を取得
      const relationProp = props["承認票DB"];
      const related = (relationProp && relationProp.relation) || [];
      if (related.length === 0) {
        console.warn("No related approval pages found for giandan:", page.id);
        continue;
      }

      // 各承認票ごとに LINE 送信
      for (const rel of related) {
        const approvalPageId = rel.id;
        const approvalPage = await callNotion(`/pages/${approvalPageId}`, {
          method: "GET",
        });

        const aProps = approvalPage.properties;

        const approverName =
          (aProps["承認者"] &&
            aProps["承認者"].people &&
            aProps["承認者"].people[0] &&
            aProps["承認者"].people[0].name) ||
          getPlainTextFromRich(aProps["承認者"]) ||
          "";

        const approveUrl = getPlainTextFromRich(aProps["approveURL"]);
        const denyUrl = getPlainTextFromRich(aProps["denyURL"]);

        const lineId = getLineUserIdByApproverName(approverName);

        const textLines = [];

        textLines.push(`${approverName || "理事"}さん`);
        textLines.push("");
        textLines.push("【Garage Tsuno 発議通知】");
        textLines.push("");
        textLines.push("案件名：");
        textLines.push(title || "（タイトルなし）");
        textLines.push("");
        if (body) {
          textLines.push("内容：");
          textLines.push(body);
          textLines.push("");
        }
        if (fileUrls.length > 0) {
          textLines.push("添付資料：");
          fileUrls.forEach((u, i) => {
            textLines.push(`・ファイル${i + 1}: ${u}`);
          });
          textLines.push("");
        }
        textLines.push("承認・否認はこちらから：");
        textLines.push(`承認：${approveUrl}`);
        textLines.push(`否認：${denyUrl}`);

        const messageText = textLines.join("\n");

        await sendLineMessage(lineId, messageText);
      }

      // 4. 送信ステータスを「送信済」に更新
      await callNotion(`/pages/${page.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            "送信ステータス": {
              select: { name: "送信済" },
            },
          },
        }),
      });
    }

    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, sent: targets.length }));
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
