// /utils/issueNumberCore.js
// 議案DBの「連番」を自動採番するコアロジック（送信時採番＋フォールバック最大限）
//
// 同じ「作成月」「承認対象」「区分キー」の中で最大連番+1 を採番する。
// 「区分キー」は以下の優先順位で決定する：
//   1) 区分コード プロパティ（Formula / Rollup / rich_text 等）
//   2) 区分 セレクト名（もしあれば）
//   3) 区分 リレーションの先頭ページID
//   4) 上記すべて空の場合 "__NO_KUBUN__" という共通キーを使う（エラーにしない）
//
// 前提：環境変数
//   NOTION_API_KEY
//   NOTION_GIAN_DATABASE_ID … 議案DB ID

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_GIAN_DATABASE_ID = process.env.NOTION_GIAN_DATABASE_ID;
const NOTION_VERSION = "2022-06-28";

/** Notion API 共通ラッパー */
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

/** ページ1件取得 */
async function fetchPage(pageId) {
  return notionFetch(`pages/${pageId}`, { method: "GET" });
}

/**
 * いろいろな形のプロパティから文字列を取り出すヘルパー
 * - Formula (string/number)
 * - Rollup (array/number/date など)
 * - rich_text
 * - title
 * - plain_text
 */
function extractTextLike(prop) {
  if (!prop) return "";

  // 1) Formula
  if (prop.formula) {
    const f = prop.formula;
    if (typeof f.string === "string" && f.string.trim().length > 0) {
      return f.string.trim();
    }
    if (typeof f.number === "number") {
      return String(f.number);
    }
  }

  // 2) Rollup
  if (prop.rollup) {
    const r = prop.rollup;

    // array タイプ（"オリジナルを表示" 等）
    if (Array.isArray(r.array) && r.array.length > 0) {
      const first = r.array[0];

      if (Array.isArray(first.rich_text)) {
        return first.rich_text
          .map((t) => t.plain_text || "")
          .join("")
          .trim();
      }
      if (Array.isArray(first.title)) {
        return first.title.map((t) => t.plain_text || "").join("").trim();
      }
      if (typeof first.plain_text === "string") {
        return first.plain_text.trim();
      }
      if (first.type && Array.isArray(first[first.type])) {
        return first[first.type]
          .map((t) => t.plain_text || "")
          .join("")
          .trim();
      }
    }

    // number rollup
    if (typeof r.number === "number") {
      return String(r.number);
    }

    // date rollup
    if (r.date && typeof r.date.start === "string") {
      return r.date.start;
    }
  }

  // 3) rich_text
  if (Array.isArray(prop.rich_text)) {
    return prop.rich_text.map((r) => r.plain_text || "").join("").trim();
  }

  // 4) title
  if (Array.isArray(prop.title)) {
    return prop.title.map((t) => t.plain_text || "").join("").trim();
  }

  // 5) plain_text
  if (typeof prop.plain_text === "string") {
    return prop.plain_text.trim();
  }

  return "";
}

/**
 * 区分キーを決定する：
 *   1) 区分コード プロパティからテキスト取得
 *   2) それが空なら 区分 セレクト名（あれば）
 *   3) それでも空なら 区分 リレーション先頭ページID
 *   4) それでも何もなければ "__NO_KUBUN__"
 */
function getKubunKey(props) {
  // 1) 区分コード プロパティ（Formula / Rollup など）
  if (props["区分コード"]) {
    const fromCode = extractTextLike(props["区分コード"]);
    if (fromCode) return fromCode;
  }

  // 2) 区分 セレクト名（もしセレクト型が使われていれば）
  const kubunSelect = props["区分"]?.select?.name ?? "";
  if (kubunSelect && kubunSelect.trim().length > 0) {
    return kubunSelect.trim();
  }

  // 3) 区分 リレーション（区分マスタDB） → ページID をそのままキーにする
  const rel = props["区分"]?.relation;
  if (Array.isArray(rel) && rel.length > 0 && rel[0].id) {
    return rel[0].id;
  }

  // 4) 何も取れない場合でも "__NO_KUBUN__" として扱う（エラーにしない）
  return "__NO_KUBUN__";
}

/**
 * 対象月＋承認対象が同じ既存議案を取得
 * created_time 範囲（start <= created_time < end）と 承認対象 で絞り込む
 */
async function queryExistingIssues({ monthStartISO, monthEndISO, approvalTarget }) {
  if (!NOTION_GIAN_DATABASE_ID) {
    throw new Error("NOTION_GIAN_DATABASE_ID が未設定です。");
  }

  const body = {
    filter: {
      and: [
        {
          timestamp: "created_time",
          created_time: {
            on_or_after: monthStartISO,
          },
        },
        {
          timestamp: "created_time",
          created_time: {
            before: monthEndISO,
          },
        },
        {
          property: "承認対象",
          select: {
            equals: approvalTarget,
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

/** 連番を書き戻し */
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
 *
 * 採番条件：
 *   同じ「作成月」「承認対象」「区分キー」の中で最大連番+1
 */
export async function ensureIssueSequence(proposalPageId) {
  // 1. 対象議案ページを取得
  const page = await fetchPage(proposalPageId);
  const props = page.properties || {};

  // すでに連番が入っていれば、そのまま返す
  const currentSeq = props["連番"]?.number ?? null;
  if (typeof currentSeq === "number" && currentSeq > 0) {
    return currentSeq;
  }

  // 作成日時（Created time プロパティ）→ JS Date
  const createdProp = props["作成日時"];
  const createdISO =
    createdProp?.created_time || page.created_time; // 念のためページ本体の created_time も fallback

  if (!createdISO) {
    throw new Error("作成日時が取得できませんでした。");
  }
  const createdDate = new Date(createdISO);

  const year = createdDate.getUTCFullYear();
  const month = createdDate.getUTCMonth(); // 0-11

  // 月初（UTC）と翌月月初（UTC）
  const monthStart = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  const monthEnd = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0));

  const monthStartISO = monthStart.toISOString();
  const monthEndISO = monthEnd.toISOString();

  // 承認対象（理事会／正会員）
  const approvalTarget = props["承認対象"]?.select?.name ?? null;
  if (!approvalTarget) {
    throw new Error("承認対象が未設定です。");
  }

  // 区分キー（空でも "__NO_KUBUN__" を返す）
  const kubunKey = getKubunKey(props);

  // 2. 同じ月＋承認対象の既存議案を取得
  const existing = await queryExistingIssues({
    monthStartISO,
    monthEndISO,
    approvalTarget,
  });

  // 3. その中から「区分キーも同じ」ものだけを対象にして最大連番を探す
  let maxSeq = 0;
  for (const item of existing) {
    if (item.id === proposalPageId) continue;

    const p = item.properties || {};
    const itemKubunKey = getKubunKey(p);
    if (itemKubunKey !== kubunKey) continue;

    const seq = p["連番"]?.number ?? 0;
    if (typeof seq === "number" && seq > maxSeq) {
      maxSeq = seq;
    }
  }

  const nextSeq = maxSeq + 1;

  // 4. 連番を書き戻す
  await updateSequence(proposalPageId, nextSeq);

  return nextSeq;
}
