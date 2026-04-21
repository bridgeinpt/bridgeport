import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSmtpConfig, mockSendMail, mockVerify } = vi.hoisted(() => ({
  mockSmtpConfig: {
    findFirst: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  mockSendMail: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
  mockVerify: vi.fn().mockResolvedValue(true),
}));

vi.mock('../lib/db.js', () => ({
  prisma: {
    smtpConfig: mockSmtpConfig,
  },
}));

vi.mock('../lib/crypto.js', () => ({
  encrypt: vi.fn().mockReturnValue({ ciphertext: 'enc-pass', nonce: 'nonce-1' }),
  decrypt: vi.fn().mockReturnValue('decrypted-password'),
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: mockSendMail,
      verify: mockVerify,
    }),
  },
}));

import { encrypt } from '../lib/crypto.js';
import {
  getSmtpConfig,
  saveSmtpConfig,
  sendEmail,
  testSmtpConnection,
  sendTestEmail,
  generateNotificationEmail,
} from './email.js';

describe('email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSmtpConfig', () => {
    it('should return null when no config exists', async () => {
      mockSmtpConfig.findFirst.mockResolvedValue(null);

      const config = await getSmtpConfig();
      expect(config).toBeNull();
    });

    it('should return formatted config when it exists', async () => {
      mockSmtpConfig.findFirst.mockResolvedValue({
        id: 'smtp-1',
        host: 'smtp.example.com',
        port: 587,
        secure: true,
        username: 'user',
        encryptedPassword: 'enc',
        passwordNonce: 'nonce',
        fromAddress: 'noreply@example.com',
        fromName: 'BRIDGEPORT',
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const config = await getSmtpConfig();
      expect(config).not.toBeNull();
      expect(config!.host).toBe('smtp.example.com');
      expect(config!.port).toBe(587);
      expect(config!.hasPassword).toBe(true);
      // Should not expose encrypted values
      expect(config).not.toHaveProperty('encryptedPassword');
    });

    it('should set hasPassword to false when no password', async () => {
      mockSmtpConfig.findFirst.mockResolvedValue({
        id: 'smtp-1',
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        username: null,
        encryptedPassword: null,
        passwordNonce: null,
        fromAddress: 'noreply@example.com',
        fromName: 'BRIDGEPORT',
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const config = await getSmtpConfig();
      expect(config!.hasPassword).toBe(false);
    });
  });

  describe('saveSmtpConfig', () => {
    it('should encrypt password when provided', async () => {
      mockSmtpConfig.findFirst.mockResolvedValue(null);
      mockSmtpConfig.create.mockResolvedValue({
        id: 'smtp-1',
        host: 'smtp.example.com',
        port: 587,
        secure: true,
        username: 'user',
        encryptedPassword: 'enc-pass',
        passwordNonce: 'nonce-1',
        fromAddress: 'noreply@example.com',
        fromName: 'BRIDGEPORT',
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await saveSmtpConfig({
        host: 'smtp.example.com',
        port: 587,
        secure: true,
        username: 'user',
        password: 'plain-password',
        fromAddress: 'noreply@example.com',
        fromName: 'BRIDGEPORT',
      });

      expect(encrypt).toHaveBeenCalledWith('plain-password');
    });

    it('should update existing config', async () => {
      mockSmtpConfig.findFirst.mockResolvedValue({ id: 'smtp-1' });
      mockSmtpConfig.update.mockResolvedValue({
        id: 'smtp-1',
        host: 'new-smtp.example.com',
        port: 465,
        secure: true,
        username: null,
        encryptedPassword: null,
        passwordNonce: null,
        fromAddress: 'admin@example.com',
        fromName: 'BRIDGEPORT',
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await saveSmtpConfig({
        host: 'new-smtp.example.com',
        port: 465,
        secure: true,
        fromAddress: 'admin@example.com',
      });

      expect(result.host).toBe('new-smtp.example.com');
      expect(mockSmtpConfig.update).toHaveBeenCalled();
    });

    it('should create new config when none exists', async () => {
      mockSmtpConfig.findFirst.mockResolvedValue(null);
      mockSmtpConfig.create.mockResolvedValue({
        id: 'smtp-1',
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        username: null,
        encryptedPassword: null,
        passwordNonce: null,
        fromAddress: 'noreply@example.com',
        fromName: 'BRIDGEPORT',
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await saveSmtpConfig({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        fromAddress: 'noreply@example.com',
      });

      expect(mockSmtpConfig.create).toHaveBeenCalled();
    });

    it('should clear password when empty string provided', async () => {
      mockSmtpConfig.findFirst.mockResolvedValue({ id: 'smtp-1' });
      mockSmtpConfig.update.mockResolvedValue({
        id: 'smtp-1',
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        username: null,
        encryptedPassword: null,
        passwordNonce: null,
        fromAddress: 'noreply@example.com',
        fromName: 'BRIDGEPORT',
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await saveSmtpConfig({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        fromAddress: 'noreply@example.com',
        password: '',
      });

      expect(mockSmtpConfig.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            encryptedPassword: null,
            passwordNonce: null,
          }),
        })
      );
    });
  });

  describe('sendEmail', () => {
    it('should return error when SMTP not configured', async () => {
      mockSmtpConfig.findFirst.mockResolvedValue(null);

      const result = await sendEmail({
        to: 'user@example.com',
        subject: 'Test',
        html: '<p>Test</p>',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('SMTP not configured');
    });

    it('should return error when SMTP is disabled', async () => {
      mockSmtpConfig.findFirst.mockResolvedValue({
        id: 'smtp-1',
        enabled: false,
      });

      const result = await sendEmail({
        to: 'user@example.com',
        subject: 'Test',
        html: '<p>Test</p>',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('SMTP not configured or disabled');
    });

    it('should send email successfully', async () => {
      // First call for createTransporter, second call for getting config
      mockSmtpConfig.findFirst
        .mockResolvedValueOnce({
          id: 'smtp-1',
          host: 'smtp.example.com',
          port: 587,
          secure: false,
          username: 'user',
          encryptedPassword: 'enc',
          passwordNonce: 'nonce',
          fromAddress: 'noreply@example.com',
          fromName: 'BRIDGEPORT',
          enabled: true,
        })
        .mockResolvedValueOnce({
          id: 'smtp-1',
          host: 'smtp.example.com',
          port: 587,
          secure: false,
          username: 'user',
          encryptedPassword: 'enc',
          passwordNonce: 'nonce',
          fromAddress: 'noreply@example.com',
          fromName: 'BRIDGEPORT',
          enabled: true,
        });

      const result = await sendEmail({
        to: 'user@example.com',
        subject: 'Test Subject',
        html: '<p>Hello</p>',
        text: 'Hello',
      });

      expect(result.success).toBe(true);
      expect(mockSendMail).toHaveBeenCalledWith({
        from: '"BRIDGEPORT" <noreply@example.com>',
        to: 'user@example.com',
        subject: 'Test Subject',
        html: '<p>Hello</p>',
        text: 'Hello',
      });
    });
  });

  describe('testSmtpConnection', () => {
    it('should return error when SMTP not configured', async () => {
      mockSmtpConfig.findFirst.mockResolvedValue(null);

      const result = await testSmtpConnection();

      expect(result.success).toBe(false);
      expect(result.error).toContain('SMTP not configured');
    });

    it('should verify connection successfully', async () => {
      mockSmtpConfig.findFirst.mockResolvedValue({
        id: 'smtp-1',
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        username: null,
        encryptedPassword: null,
        passwordNonce: null,
        fromAddress: 'noreply@example.com',
        fromName: 'BRIDGEPORT',
        enabled: true,
      });

      const result = await testSmtpConnection();

      expect(result.success).toBe(true);
      expect(mockVerify).toHaveBeenCalled();
    });
  });

  describe('sendTestEmail', () => {
    it('should send a test email to the given address', async () => {
      mockSmtpConfig.findFirst
        .mockResolvedValueOnce({
          id: 'smtp-1',
          host: 'smtp.example.com',
          port: 587,
          secure: false,
          username: null,
          encryptedPassword: null,
          passwordNonce: null,
          fromAddress: 'noreply@example.com',
          fromName: 'BRIDGEPORT',
          enabled: true,
        })
        .mockResolvedValueOnce({
          id: 'smtp-1',
          fromAddress: 'noreply@example.com',
          fromName: 'BRIDGEPORT',
        });

      const result = await sendTestEmail('test@example.com');

      expect(result.success).toBe(true);
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'test@example.com',
          subject: 'BRIDGEPORT Test Email',
        })
      );
    });
  });

  describe('generateNotificationEmail', () => {
    it('should generate HTML and text for info severity', () => {
      const { html, text } = generateNotificationEmail(
        'Deployment Success',
        'Service web-app deployed successfully',
        'info'
      );

      expect(html).toContain('Deployment Success');
      expect(html).toContain('Service web-app deployed successfully');
      expect(text).toContain('Deployment Success');
      expect(text).toContain('Service web-app deployed successfully');
    });

    it('should include environment name when provided', () => {
      const { html, text } = generateNotificationEmail(
        'Alert',
        'Something happened',
        'warning',
        'production'
      );

      expect(html).toContain('production');
      expect(text).toContain('production');
    });

    it('should use critical severity styling', () => {
      const { html } = generateNotificationEmail(
        'Critical Error',
        'Server unreachable',
        'critical'
      );

      // Should contain red color for critical
      expect(html).toContain('#dc2626');
    });

    it('should use warning severity styling', () => {
      const { html } = generateNotificationEmail(
        'Warning',
        'Disk space low',
        'warning'
      );

      // Should contain warning color
      expect(html).toContain('#ca8a04');
    });

    it('should use info severity styling as default', () => {
      const { html } = generateNotificationEmail(
        'Info',
        'Normal event',
        'unknown-severity'
      );

      // Should fall back to info color
      expect(html).toContain('#2563eb');
    });

    it('should include BRIDGEPORT branding', () => {
      const { html, text } = generateNotificationEmail(
        'Test',
        'Test message',
        'info'
      );

      expect(html).toContain('BRIDGEPORT');
      expect(text).toContain('BRIDGEPORT');
    });
  });
});
