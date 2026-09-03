export interface SessionToken {
  subject: string;
  expiresAt: number;
}

export type RenewalResult =
  | { status: 200; body: { token: string } }
  | { status: 401; body: { error: "invalid_token" } };

export function renewSession(token: SessionToken, nowEpochSeconds: number): RenewalResult {
  if (!token.subject) {
    return { status: 401, body: { error: "invalid_token" } };
  }

  return {
    status: 200,
    body: { token: `renewed:${token.subject}:${nowEpochSeconds}` },
  };
}
