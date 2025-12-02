// /api/autoIssueNumber.js
// 議案番号用「連番」自動採番API
// Notion Automations の Webhook から呼び出す

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DB_ID = process.env.NOTION_GIAN_DATABASE_ID;
const NOTION_VERSION = "2022-06-28";

async function fetchPage(pageId) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch page: ${res.status} ${text}`);
  }

  return res.json();
}

async function queryExistingRecords({ yy, mm, meetingCode, kubun }) {
  const body = {
    filter: {
      and: [
        {
          property: "YY",
          formula: {
            string: {
              equals: yy,
            },
          },
        },
        {
          property: "MM",
          formula: {
            string: {
              equals: mm,
            },
          },
        },
        {
          property: "会議体コード",
          formula: {
            string: {
              equals: meetingCode,
            },
          },
        },
        {
          property: "区分",
          select: {
            equals: kubun,
          },
        },
      ],
    },
    // 念のため多めに取得（1ヶ月＋区分の議案数はそこまで多くない想定）
    page_size: 100,
  };

  const res = await fetch(
    `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to query database: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.results || [];
}

async function updateSequence(pageId, seq) {
  const body = {
    properties: {
      // 「連番」プロパティ（Number）に書き込む
      連番: {
        number: seq,
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
    throw new Error(`Failed to update page: ${res.status} ${text}`);
  }

  return res.json();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ status: "error", message: "Method Not Allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const pageId = body.pageId || body.page_id;
    if (!pageId) {
      return res
        .status(400)
        .json({ status: "error", message: "pageId is required" });
    }

    // 1. 対象ページを取得
    const page = await fetchPage(pageId);
    const props = page.properties || {};

    const yy =
      props["YY"]?.formula?.string ??
      props["YY"]?.formula?.number?.toString() ??
      null;
    const mm = props["MM"]?.formula?.string ?? null;
    const meetingCode = props["会議体コード"]?.formula?.string ?? null;
    const kubun = props["区分"]?.select?.name ?? null;

    if (!yy || !mm || !meetingCode || !kubun) {
      return res.status(400).json({
        status: "error",
        message: "Missing required properties (YY/MM/会議体コード/区分)",
        debug: { yy, mm, meetingCode, kubun },
      });
    }

    // 2. 既存レコードから最大連番を取得
    const existing = await queryExistingRecords({ yy, mm, meetingCode, kubun });

    let maxSeq = 0;
    for (const item of existing) {
      // 自分自身は除外（念のため）
      if (item.id === pageId) continue;

      const p = item.properties || {};
      const seq = p["連番"]?.number ?? 0;
      if (typeof seq === "number" && seq > maxSeq) {
        maxSeq = seq;
      }
    }

    const nextSeq = maxSeq + 1;

    // 3. 対象ページに連番を書き戻し
    await updateSequence(pageId, nextSeq);

    return res.status(200).json({
      status: "ok",
      pageId,
      yy,
      mm,
      meetingCode,
      kubun,
      seq: nextSeq,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      status: "error",
      message: err.message || "Internal Server Error",
    });
  }
};
