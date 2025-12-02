// /utils/issueNumberCore.js
// 議案DBの「連番」を自動採番する関数群

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_GIAN_DATABASE_ID = process.env.NOTION_GIAN_DATABASE_ID;
const NOTION_VERSION = "2022-06-28";

async function notionFetch(path, options = {}) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
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
    throw new Error(
      `Notion API error [${path}]: ${res.status} ${text || res.statusText}`
    );
  }

  return res.json();
}

async function fetchPage(pageId) {
  return notionFetch(`pages/${pageId}`, { method: "GET" });
}

async function queryExistingIssueNumbers({ yy, mm, meetingCode, kubun }) {
  const body = {
    filter: {
      and: [
        {
          property: "YY",
          formula: {
            string: { equals: yy },
          },
        },
        {
          property: "MM",
          formula: {
            string: { equals: mm },
          },
        },
        {
          property: "会議体コード",
          formula: {
            string: { equals: meetingCode },
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
    page_size: 100,
  };

  const data = await notionFetch(
    `databases/${NOTION_GIAN_DATABASE_ID}/query`,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  );

  return data.results || [];
}

async function updateSequence(pageId, seq) {
  const body = {
    properties: {
      連番: {
        number: seq,
      },
    },
  };

  await notionFetch(`pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/**
 * 議案ページIDを渡すと：
 * - 連番が未設定なら、自動採番して書き込む
 * - すでに入っていれば、その値をそのまま返す
 */
export async function ensureIssueSequence(proposalPageId) {
  // 1. ページ取得
  const page = await fetchPage(proposalPageId);
  const props = page.properties || {};

  // すでに連番が入っていればそれを返す
  const currentSeq = props["連番"]?.number ?? null;
  if (typeof currentSeq === "number" && currentSeq > 0) {
    return currentSeq;
  }

  // YY / MM / 会議体コード / 区分 を取得
  const yy =
    props["YY"]?.formula?.string ??
    (typeof props["YY"]?.formula?.number === "number"
      ? String(props["YY"].formula.number)
      : null);
  const mm = props["MM"]?.formula?.string ?? null;
  const meetingCode = props["会議体コード"]?.formula?.string ?? null;
  const kubun = props["区分"]?.select?.name ?? null;

  if (!yy || !mm || !meetingCode || !kubun) {
    throw new Error(
      `議案ページに必要な値が足りません (YY/MM/会議体コード/区分)`
    );
  }

  // 2. 同じ YY+MM+会議体+区分 の既存レコードを検索して最大連番を求める
  const existing = await queryExistingIssueNumbers({
    yy,
    mm,
    meetingCode,
    kubun,
  });

  let maxSeq = 0;
  for (const item of existing) {
    if (item.id === proposalPageId) continue;
    const p = item.properties || {};
    const seq = p["連番"]?.number ?? 0;
    if (typeof seq === "number" && seq > maxSeq) {
      maxSeq = seq;
    }
  }

  const nextSeq = maxSeq + 1;

  // 3. 連番を書き戻し
  await updateSequence(proposalPageId, nextSeq);

  return nextSeq;
}
