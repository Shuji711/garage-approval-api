// api/sendApprovalMessage.js

import { sendApprovalMessage } from "../utils/sendApprovalCore.js";

export default async function handler(req, res) {
  try {
    // クエリから pageId を取得
    const { pageId } = req.query;

    if (!pageId) {
      res.status(400).json({
        status: "error",
        message: "Missing pageId",
      });
      return;
    }

    // Notion 承認票ページIDを渡して送信
    const result = await sendApprovalMessage(pageId);

    res.status(200).json({
      status: "ok",
      result,
    });
  } catch (err) {
    console.error("Error in sendApprovalMessage:", err);
    res.status(500).json({
      status: "error",
      message: err.message || "Unknown error",
    });
  }
}
