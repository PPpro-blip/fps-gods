const EMAIL_TIMEOUT_MS = 8_000;

function buildOtpEmailContent(code, expiresInMinutes) {
  const subject = 'FPS GODS — Your 6-digit verification code';
  const text = [
    'FPS GODS ACCOUNT VERIFICATION',
    '',
    `Your one-time verification code is: ${code}`,
    '',
    `This code expires in ${expiresInMinutes} minutes and can only be used once.`,
    'If you did not request this code, you can safely ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0a1017;color:#e7f3ff;padding:28px;border-radius:12px;max-width:460px;margin:0 auto;border:1px solid #1e3346;">
      <div style="font-size:12px;letter-spacing:0.18em;color:#57d8ff;font-weight:700;text-transform:uppercase;">FPS GODS // ACCOUNT SECURITY</div>
      <h2 style="margin:12px 0 8px;font-size:20px;color:#ffffff;">Sign-in Verification Code</h2>
      <p style="margin:0 0 18px;color:#9cb3c9;font-size:14px;line-height:1.5;">Enter this single-use code in FPS GODS to verify your operator account:</p>
      <div style="background:#111c27;border:1px solid #2b4c66;border-radius:8px;padding:16px;text-align:center;font-size:28px;font-weight:800;letter-spacing:0.28em;color:#57d8ff;">${code}</div>
      <p style="margin:18px 0 0;color:#7890a8;font-size:12px;line-height:1.5;">Expires in ${expiresInMinutes} minutes. Never share this code with anyone.</p>
    </div>
  `.trim();

  return { subject, text, html };
}

/**
 * Transactional email OTP delivery adapter.
 *
 * Supports Resend (`RESEND_API_KEY` + `AUTH_EMAIL_FROM`), SendGrid
 * (`SENDGRID_API_KEY` + `AUTH_EMAIL_FROM`), or an authenticated internal HTTP
 * relay (`OTP_EMAIL_WEBHOOK_URL` + `AUTH_EMAIL_FROM`), plus explicit provider
 * injection for automated tests.
 *
 * When unconfigured, it honestly reports `configured: false` and throws
 * `EMAIL_PROVIDER_UNCONFIGURED` — it NEVER logs raw OTP codes to stdout/stderr
 * or fakes delivery.
 */
export function createEmailProvider(customProvider = null) {
  if (customProvider && typeof customProvider.sendOtpEmail === 'function') {
    return {
      name: customProvider.name || 'custom',
      configured: customProvider.configured !== false,
      sendOtpEmail: (params) => customProvider.sendOtpEmail(params),
    };
  }

  const from = (process.env.AUTH_EMAIL_FROM || '').trim();
  const resendKey = (process.env.RESEND_API_KEY || '').trim();
  const sendgridKey = (process.env.SENDGRID_API_KEY || '').trim();
  const webhookUrl = (process.env.AUTH_EMAIL_WEBHOOK_URL || process.env.OTP_EMAIL_WEBHOOK_URL || '').trim();
  const webhookSecret = (process.env.AUTH_EMAIL_WEBHOOK_SECRET || process.env.OTP_EMAIL_WEBHOOK_SECRET || '').trim();

  if (resendKey && from) {
    return {
      name: 'resend',
      configured: true,
      async sendOtpEmail({ to, code, expiresInMinutes = 5 }) {
        const { subject, text, html } = buildOtpEmailContent(code, expiresInMinutes);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
        try {
          const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${resendKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ from, to: [to], subject, text, html }),
            signal: controller.signal,
          });
          if (!res.ok) {
            const err = new Error('Email provider rejected OTP dispatch.');
            err.code = 'EMAIL_DELIVERY_FAILED';
            err.status = 502;
            throw err;
          }
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }

  if (sendgridKey && from) {
    return {
      name: 'sendgrid',
      configured: true,
      async sendOtpEmail({ to, code, expiresInMinutes = 5 }) {
        const { subject, text, html } = buildOtpEmailContent(code, expiresInMinutes);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
        try {
          const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${sendgridKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: to }] }],
              from: { email: from },
              subject,
              content: [
                { type: 'text/plain', value: text },
                { type: 'text/html', value: html },
              ],
            }),
            signal: controller.signal,
          });
          if (!res.ok) {
            const err = new Error('Email provider rejected OTP dispatch.');
            err.code = 'EMAIL_DELIVERY_FAILED';
            err.status = 502;
            throw err;
          }
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }

  if (webhookUrl && from) {
    return {
      name: 'webhook',
      configured: true,
      async sendOtpEmail({ to, code, expiresInMinutes = 5 }) {
        const { subject, text, html } = buildOtpEmailContent(code, expiresInMinutes);
        const headers = { 'Content-Type': 'application/json' };
        if (webhookSecret) headers['X-OTP-Webhook-Secret'] = webhookSecret;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
        try {
          const res = await fetch(webhookUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ from, to, subject, text, html, expiresInMinutes }),
            signal: controller.signal,
          });
          if (!res.ok) {
            const err = new Error('OTP webhook rejected dispatch.');
            err.code = 'EMAIL_DELIVERY_FAILED';
            err.status = 502;
            throw err;
          }
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }

  return {
    name: 'unconfigured',
    configured: false,
    async sendOtpEmail() {
      const err = new Error(
        'Email OTP delivery is not configured on this server. Configure RESEND_API_KEY (or SENDGRID_API_KEY) and AUTH_EMAIL_FROM on the backend.',
      );
      err.code = 'EMAIL_PROVIDER_UNCONFIGURED';
      err.status = 503;
      throw err;
    },
  };
}
