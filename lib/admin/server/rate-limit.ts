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

  consume(userId: string, bytes: number, now = Date.now()): void {
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
