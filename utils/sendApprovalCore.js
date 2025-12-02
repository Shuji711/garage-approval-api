// /utils/sendApprovalCore.js
import { ensureIssueSequence } from "@/utils/issueNumberCore";

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
// 必要に応じて送信先IDの管理方法を合わせてください

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

async function sendLineMessage(toIds, text) {
  const body = {
    to: toIds,
    messages: [{ type: "text", text }],
  };

  const res = await fetch("https://api.line.me/v2/bot/message/multicast", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`LINE send error: ${res.status} ${txt}`);
  }
}

// ★ 議案番号のプロパティ名（いま「議案番号フォーミュラ」ならここを書き換え）
const ISSUE_NO_PROP_NAME = "議案番号フォーミュラ"; // or "議案番号"

export async function sendApprovalMessage(approvalPageId, toIds) {
  // ① 承認票ページを取得
  const approvalPage = await fetchPage(approvalPageId);
  const approvalProps = approvalPage.properties || {};

  // ② 議案リレーションから議案ページIDを取得（プロパティ名は実際に合わせて）
  const proposalRel = approvalProps["議案"]?.relation ?? [];
  const proposalPageId = proposalRel[0]?.id;
  if (!proposalPageId) {
    throw new Error("承認票に議案が紐づいていません。");
  }

  // ③ ここで「連番」を自動確定（未採番なら振る）
  await ensureIssueSequence(proposalPageId);

  // ④ 採番後の議案ページを再取得し、議案番号を取得
  const proposalPage = await fetchPage(proposalPageId);
  const proposalProps = proposalPage.properties || {};

  const issueNo =
    proposalProps[ISSUE_NO_PROP_NAME]?.formula?.string ??
    proposalProps[ISSUE_NO_PROP_NAME]?.rich_text?.[0]?.plain_text ??
    "";

  // タイトル（件名）も取っておく（プロパティ名は実際のタイトル名に合わせて）
  const titleProp = proposalProps["議案"] || proposalProps["名前"] || proposalProps["Name"];
  const title =
    titleProp?.title?.[0]?.plain_text ??
    "(件名未設定)";

  // ⑤ LINE本文組み立て（ここは好きなように変えてOK）
  const lineText =
    `議案番号：${issueNo}\n` +
    `件名：${title}\n\n` +
    `この議案について承認・否認のご回答をお願いします。`;

  // ⑥ LINE送信（toIds の扱いは、現状の実装に合わせてください）
  await sendLineMessage(toIds, lineText);

  return { ok: true, issueNo };
}
