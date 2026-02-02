import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { prisma } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';

interface SmtpConfigInput {
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  password?: string;
  fromAddress: string;
  fromName?: string;
  enabled?: boolean;
}

interface SmtpConfigOutput {
  id: string;
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  hasPassword: boolean;
  fromAddress: string;
  fromName: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Get SMTP configuration
 */
export async function getSmtpConfig(): Promise<SmtpConfigOutput | null> {
  const config = await prisma.smtpConfig.findFirst();
  if (!config) return null;

  return {
    id: config.id,
    host: config.host,
    port: config.port,
    secure: config.secure,
    username: config.username,
    hasPassword: !!config.encryptedPassword,
    fromAddress: config.fromAddress,
    fromName: config.fromName,
    enabled: config.enabled,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

/**
 * Save or update SMTP configuration
 */
export async function saveSmtpConfig(input: SmtpConfigInput): Promise<SmtpConfigOutput> {
  const existing = await prisma.smtpConfig.findFirst();

  const data: {
    host: string;
    port: number;
    secure: boolean;
    username: string | null;
    encryptedPassword?: string | null;
    passwordNonce?: string | null;
    fromAddress: string;
    fromName: string;
    enabled: boolean;
  } = {
    host: input.host,
    port: input.port,
    secure: input.secure,
    username: input.username || null,
    fromAddress: input.fromAddress,
    fromName: input.fromName || 'BridgePort',
    enabled: input.enabled ?? true,
  };

  // Encrypt password if provided
  if (input.password) {
    const { ciphertext, nonce } = encrypt(input.password);
    data.encryptedPassword = ciphertext;
    data.passwordNonce = nonce;
  } else if (input.password === '') {
    // Explicitly clear password
    data.encryptedPassword = null;
    data.passwordNonce = null;
  }

  let config;
  if (existing) {
    config = await prisma.smtpConfig.update({
      where: { id: existing.id },
      data,
    });
  } else {
    config = await prisma.smtpConfig.create({ data });
  }

  return {
    id: config.id,
    host: config.host,
    port: config.port,
    secure: config.secure,
    username: config.username,
    hasPassword: !!config.encryptedPassword,
    fromAddress: config.fromAddress,
    fromName: config.fromName,
    enabled: config.enabled,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

/**
 * Create a nodemailer transporter from stored SMTP config
 */
async function createTransporter(): Promise<Transporter | null> {
  const config = await prisma.smtpConfig.findFirst();
  if (!config || !config.enabled) return null;

  let password: string | undefined;
  if (config.encryptedPassword && config.passwordNonce) {
    password = decrypt(config.encryptedPassword, config.passwordNonce);
  }

  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.username
      ? {
          user: config.username,
          pass: password,
        }
      : undefined,
  });
}

/**
 * Send an email
 */
export async function sendEmail(options: SendEmailOptions): Promise<{ success: boolean; error?: string }> {
  try {
    const transporter = await createTransporter();
    if (!transporter) {
      return { success: false, error: 'SMTP not configured or disabled' };
    }

    const config = await prisma.smtpConfig.findFirst();
    if (!config) {
      return { success: false, error: 'SMTP not configured' };
    }

    await transporter.sendMail({
      from: `"${config.fromName}" <${config.fromAddress}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to send email';
    console.error('[Email] Send failed:', errorMessage);
    return { success: false, error: errorMessage };
  }
}

/**
 * Test SMTP connection
 */
export async function testSmtpConnection(): Promise<{ success: boolean; error?: string }> {
  try {
    const transporter = await createTransporter();
    if (!transporter) {
      return { success: false, error: 'SMTP not configured or disabled' };
    }

    await transporter.verify();
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Connection test failed';
    return { success: false, error: errorMessage };
  }
}

/**
 * Send a test email
 */
export async function sendTestEmail(to: string): Promise<{ success: boolean; error?: string }> {
  return sendEmail({
    to,
    subject: 'BridgePort Test Email',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1e40af;">BridgePort Email Test</h2>
        <p>This is a test email from BridgePort to verify your SMTP configuration is working correctly.</p>
        <p style="color: #64748b; font-size: 12px; margin-top: 20px;">
          Sent at ${new Date().toISOString()}
        </p>
      </div>
    `,
    text: `BridgePort Email Test\n\nThis is a test email from BridgePort to verify your SMTP configuration is working correctly.\n\nSent at ${new Date().toISOString()}`,
  });
}

/**
 * Generate HTML email for notification
 */
export function generateNotificationEmail(
  title: string,
  message: string,
  severity: string,
  environmentName?: string
): { html: string; text: string } {
  const severityColors: Record<string, { bg: string; text: string }> = {
    critical: { bg: '#fef2f2', text: '#dc2626' },
    warning: { bg: '#fefce8', text: '#ca8a04' },
    info: { bg: '#eff6ff', text: '#2563eb' },
  };

  const colors = severityColors[severity] || severityColors.info;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #0f172a; padding: 20px; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 24px;">BridgePort</h1>
      </div>
      <div style="background: ${colors.bg}; padding: 20px; border-left: 4px solid ${colors.text};">
        <h2 style="color: ${colors.text}; margin: 0 0 10px 0; font-size: 18px;">${title}</h2>
        ${environmentName ? `<p style="color: #64748b; margin: 0 0 10px 0; font-size: 12px;">Environment: ${environmentName}</p>` : ''}
        <p style="color: #334155; margin: 0;">${message}</p>
      </div>
      <div style="background: #f8fafc; padding: 15px 20px; border-radius: 0 0 8px 8px;">
        <p style="color: #64748b; font-size: 12px; margin: 0;">
          This is an automated notification from BridgePort.
        </p>
      </div>
    </div>
  `;

  const text = `${title}\n\n${environmentName ? `Environment: ${environmentName}\n\n` : ''}${message}\n\n---\nThis is an automated notification from BridgePort.`;

  return { html, text };
}
