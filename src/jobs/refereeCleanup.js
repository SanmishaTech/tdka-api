const prisma = require('../config/db');

let isRunning = false;
let timer = null;

function parseToDateEndOfDay(value) {
  if (!value) return null;
  try {
    if (value instanceof Date) {
      if (isNaN(value)) return null;
      const d = new Date(value);
      d.setHours(23, 59, 59, 999);
      return d;
    }
    if (typeof value === 'string') {
      const s = value.trim();
      // YYYY-MM-DD (or ISO-like)
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        const d = new Date(s);
        if (isNaN(d)) return null;
        d.setHours(23, 59, 59, 999);
        return d;
      }
      // DD/MM/YYYY
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
        const [dd, mm, yyyy] = s.split('/').map((x) => parseInt(x, 10));
        const d = new Date(yyyy, mm - 1, dd, 23, 59, 59, 999);
        return isNaN(d) ? null : d;
      }
      // fallback
      const d = new Date(s);
      if (isNaN(d)) return null;
      d.setHours(23, 59, 59, 999);
      return d;
    }
  } catch (_) {
    return null;
  }
  return null;
}

async function cleanupExpiredReferees() {
  if (isRunning) return; // prevent overlap
  isRunning = true;
  const startedAt = new Date();

  try {
    // Fetch competitions that currently have a referee assigned
    const competitions = await prisma.competition.findMany({
      where: { NOT: { refereeId: null } },
      select: { id: true, competitionName: true, toDate: true, refereeId: true },
    });

    const now = new Date();
    // Separate expired competitions
    const expired = competitions.filter((c) => {
      const eod = parseToDateEndOfDay(c.toDate);
      return eod && now > eod;
    });

    if (expired.length === 0) return;

    // Group expired competitions by refereeId
    const groups = new Map();
    for (const c of expired) {
      if (!groups.has(c.refereeId)) groups.set(c.refereeId, []);
      groups.get(c.refereeId).push(c);
    }

    for (const [refereeId, comps] of groups.entries()) {
      try {
        // Ensure we don't delete non-referee roles
        const user = await prisma.user.findUnique({
          where: { id: refereeId },
          select: { id: true, role: true },
        });

        // If user disappeared already, just skip
        if (!user) continue;

        const totalRefCount = await prisma.competition.count({ where: { refereeId } });
        const expiredIds = comps.map((c) => c.id);

        if (expiredIds.length >= totalRefCount && user.role === 'referee') {
          // All references are expired -> delete the referee user; FK will SetNull
          await prisma.user.delete({ where: { id: refereeId } });
          console.log(`[RefereeCleanup] Deleted referee ${refereeId}; competitions affected: ${expiredIds.join(', ')}`);
        } else {
          // Some references still active or user is not referee -> detach from expired ones only
          await prisma.competition.updateMany({
            where: { id: { in: expiredIds }, refereeId },
            data: { refereeId: null },
          });
          console.log(`[RefereeCleanup] Detached referee ${refereeId} from competitions: ${expiredIds.join(', ')}`);
        }
      } catch (e) {
        console.error(`[RefereeCleanup] Error processing referee ${refereeId}`, e);
      }
    }
  } catch (err) {
    console.error('[RefereeCleanup] Job failed', err);
  } finally {
    isRunning = false;
    const finishedAt = new Date();
    const ms = finishedAt - startedAt;
    if (ms > 10000) {
      console.log(`[RefereeCleanup] Job completed in ${ms}ms`);
    }
  }
}

function startRefereeCleanupJob(intervalMs = 60_000) {
  // immediate run on boot, then every interval
  cleanupExpiredReferees().catch(() => {});
  timer = setInterval(() => cleanupExpiredReferees().catch(() => {}), intervalMs);
  console.log(`[RefereeCleanup] Scheduled every ${intervalMs / 1000}s`);
  return timer;
}

function stopRefereeCleanupJob() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  startRefereeCleanupJob,
  stopRefereeCleanupJob,
  cleanupExpiredReferees,
};
