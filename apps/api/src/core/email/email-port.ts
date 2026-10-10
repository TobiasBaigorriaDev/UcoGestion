export type EmailMessage = {
  readonly email: string;
  readonly jobKey: string;
  readonly token: string;
} & ({ readonly template: 'PASSWORD_RESET' } | {
  readonly template: 'INVITATION';
  readonly role: string;
  readonly branchIds: readonly string[];
});

// Providers must deduplicate jobKey, including retries after an uncertain ACK.
export interface EmailPort {
  send(message: EmailMessage): Promise<void>;
}

export class HttpEmailPort implements EmailPort {
  constructor(private readonly endpoint: string, private readonly credential: string) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new Error('Email gateway requires HTTPS.');
    }
    if (!credential) throw new Error('Email gateway credential is required.');
  }

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch(this.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.credential}`,
        'Idempotency-Key': message.jobKey },
      body: JSON.stringify(message),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error('Email gateway rejected delivery.');
  }
}
