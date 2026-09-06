export function normalizeServer(value: string, allowHttp?: boolean): string;
export function parseComposeLink(raw: string): Record<string, string>;
export function linkPath(raw: string): string;
export function notificationPath(event: { threadId: string }): string;
