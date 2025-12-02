// api/cron.js

module.exports = async (req, res) => {
  console.log("cron endpoint called");
  res.status(200).json({ ok: true, message: "cron endpoint alive" });
};
