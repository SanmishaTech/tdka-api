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
      // YYYY-MM-DD (or ISO-like) -> rely on Date; then set EOD
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

async function cleanupExpiredObservers() {
  if (isRunning) return; // prevent overlap
  isRunning = true;
  const startedAt = new Date();

  try {
    // Fetch competitions that currently have an observer assigned
    const competitions = await prisma.competition.findMany({
      where: { NOT: { observerId: null } },
      select: { id: true, competitionName: true, toDate: true, observerId: true },
    });

    const now = new Date();
    // Separate expired competitions
    const expired = competitions.filter((c) => {
      const eod = parseToDateEndOfDay(c.toDate);
      return eod && now > eod;
    });

    if (expired.length === 0) return;

    // Group expired competitions by observerId
    const groups = new Map();
    for (const c of expired) {
      if (!groups.has(c.observerId)) groups.set(c.observerId, []);
      groups.get(c.observerId).push(c);
    }

    for (const [observerId, comps] of groups.entries()) {
      try {
        // Ensure we don't delete non-observer roles
        const user = await prisma.user.findUnique({
          where: { id: observerId },
          select: { id: true, role: true },
        });

        // If user disappeared already, just skip
        if (!user) continue;

        const totalRefCount = await prisma.competition.count({ where: { observerId } });
        const expiredIds = comps.map((c) => c.id);

        if (expiredIds.length >= totalRefCount && user.role === 'observer') {
          // All references are expired -> delete the observer user; FK will SetNull
          await prisma.user.delete({ where: { id: observerId } });
          console.log(`[ObserverCleanup] Deleted observer ${observerId}; competitions affected: ${expiredIds.join(', ')}`);
        } else {
          // Some references still active or user is not observer -> detach from expired ones only
          await prisma.competition.updateMany({
            where: { id: { in: expiredIds }, observerId },
            data: { observerId: null },
          });
          console.log(`[ObserverCleanup] Detached observer ${observerId} from competitions: ${expiredIds.join(', ')}`);
        }
      } catch (e) {
        console.error(`[ObserverCleanup] Error processing observer ${observerId}`, e);
      }
    }
  } catch (err) {
    console.error('[ObserverCleanup] Job failed', err);
  } finally {
    isRunning = false;
    const finishedAt = new Date();
    const ms = finishedAt - startedAt;
    if (ms > 10000) {
      console.log(`[ObserverCleanup] Job completed in ${ms}ms`);
    }
  }
}

function startObserverCleanupJob(intervalMs = 60_000) {
  // immediate run on boot, then every interval
  cleanupExpiredObservers().catch(() => {});
  timer = setInterval(() => cleanupExpiredObservers().catch(() => {}), intervalMs);
  console.log(`[ObserverCleanup] Scheduled every ${intervalMs / 1000}s`);
  return timer;
}

function stopObserverCleanupJob() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  startObserverCleanupJob,
  stopObserverCleanupJob,
  cleanupExpiredObservers,
};
