// /api/sendApproval.js

import { sendApprovalMessage } from "../utils/sendApprovalCore";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      status: "error",
      message: "Method not allowed",
    });
  }

  const { pageId } = req.query;

  if (!pageId) {
    return res.status(400).json({
      status: "error",
      message: "Missing pageId",
    });
  }

  try {
    // Notion から会員DBを辿って LINEユーザーID を取り、
    // LINE に承認依頼を送る本体処理
    const result = await sendApprovalMessage(pageId);

    if (!result.ok) {
      return res.status(400).json({
        status: "error",
        message: result.error || "Failed to send approval message",
      });
    }

    return res.status(200).json({
      status: "ok",
      result,
    });
  } catch (e) {
    console.error("sendApproval error:", e);
    return res.status(500).json({
      status: "error",
      message: e.message || "Internal server error",
    });
  }
}
