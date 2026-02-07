const prisma = require("../config/db");

let isRunning = false;
let timer = null;

const parseRetentionDays = () => {
  const raw = process.env.ACTIVITY_LOG_RETENTION_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};

async function cleanupOldActivityLogs() {
  if (isRunning) return;
  isRunning = true;

  try {
    const days = parseRetentionDays();
    if (!days) return;

    if (!prisma?.activityLog) return;

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const result = await prisma.activityLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    if (result?.count) {
      console.log(`[ActivityLogCleanup] Deleted ${result.count} logs older than ${days} days`);
    }
  } catch (err) {
    console.error("[ActivityLogCleanup] Job failed", err);
  } finally {
    isRunning = false;
  }
}

function startActivityLogCleanupJob(intervalMs = 86_400_000) {
  cleanupOldActivityLogs().catch(() => {});
  timer = setInterval(() => cleanupOldActivityLogs().catch(() => {}), intervalMs);
  console.log(`[ActivityLogCleanup] Scheduled every ${Math.round(intervalMs / 1000)}s`);
  return timer;
}

function stopActivityLogCleanupJob() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  startActivityLogCleanupJob,
  stopActivityLogCleanupJob,
  cleanupOldActivityLogs,
};
