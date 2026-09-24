import { UploadContractError } from '@/lib/admin/upload-errors';

export const UPLOAD_RATE_LIMITS = {
  uploadsPerMinute: 20,
  uploadsPerHour: 200,
  bytesPerHour: 5 * 1024 * 1024 * 1024,
} as const;

type UploadEvent = { at: number; bytes: number };

export interface UploadRateLimiter {
  consume(userId: string, bytes: number, now?: number): void;
}

export class InMemoryUploadRateLimiter implements UploadRateLimiter {
  private readonly events = new Map<string, UploadEvent[]>();
  private lastSweepAt = 0;

  // Sweep inactive users on traffic rather than keeping a process-wide timer.
  private pruneExpired(now: number): void {
    if (now >= this.lastSweepAt && now - this.lastSweepAt < 60_000) return;
    const hourAgo = now - 60 * 60 * 1000;
    for (const [userId, events] of this.events) {
      const recent = events.filter((event) => event.at > hourAgo);
      if (recent.length) this.events.set(userId, recent);
      else this.events.delete(userId);
    }
    this.lastSweepAt = now;
  }

  consume(userId: string, bytes: number, now = Date.now()): void {
    this.pruneExpired(now);
    const hourAgo = now - 60 * 60 * 1000;
    const minuteAgo = now - 60 * 1000;
    const recent = (this.events.get(userId) ?? []).filter((event) => event.at > hourAgo);
    const minuteCount = recent.filter((event) => event.at > minuteAgo).length;
    const hourBytes = recent.reduce((total, event) => total + event.bytes, 0);

    if (
      minuteCount >= UPLOAD_RATE_LIMITS.uploadsPerMinute ||
      recent.length >= UPLOAD_RATE_LIMITS.uploadsPerHour ||
      hourBytes + bytes > UPLOAD_RATE_LIMITS.bytesPerHour
    ) {
      throw new UploadContractError(429, 'RATE_LIMITED', 'Upload rate limit exceeded');
    }
    recent.push({ at: now, bytes });
    this.events.set(userId, recent);
  }
}

export const uploadRateLimiter = new InMemoryUploadRateLimiter();
