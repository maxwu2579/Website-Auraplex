import { isIP } from 'node:net';

export interface UploadAuditEvent {
  user: string;
  action: 'upload.accepted' | 'upload.failed' | 'delete.accepted' | 'delete.failed' | 'delete.partial';
  key: string;
  size: number;
  ip: string;
  timestamp: string;
}

export interface AuditLogger {
  write(event: UploadAuditEvent): void;
}

export const jsonAuditLogger: AuditLogger = {
  write(event) {
    console.info(JSON.stringify({ type: 'admin_upload_audit', ...event }));
  },
};

export function requestIp(headers: Headers): string {
  const candidates = [
    headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
    headers.get('x-real-ip')?.trim(),
  ];
  return candidates.find((candidate) => candidate && isIP(candidate)) || 'unknown';
}
