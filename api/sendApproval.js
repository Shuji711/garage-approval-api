// /api/sendApproval.js

const { sendApprovalMessage } = require("../utils/sendApprovalCore");

module.exports = async function handler(req, res) {
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
    const result = await sendApprovalMessage(pageId);

    if (!result.ok) {
      return res.status(400).json({
        status: "error",
        message: result.error || "Failed to send approval message",
        debug: result.debug || null,
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
};
