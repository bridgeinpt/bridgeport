/**
 * Mock DigitalOcean Spaces (S3-compatible) client for tests.
 *
 * Simulates S3 operations in memory for backup storage tests.
 */
import { vi } from 'vitest';

export interface MockS3Object {
  key: string;
  body: Buffer | string;
  contentType?: string;
  metadata?: Record<string, string>;
}

export function createMockSpaces(): {
  /** Mock S3 send function */
  send: ReturnType<typeof vi.fn>;
  /** Uploaded objects keyed by bucket:key */
  objects: Map<string, MockS3Object>;
  /** Clear all stored objects */
  clear: () => void;
  /** Add a pre-existing object */
  addObject: (bucket: string, obj: MockS3Object) => void;
  /** Set send to fail */
  setFailure: (error: string | null) => void;
} {
  const objects = new Map<string, MockS3Object>();
  let failure: string | null = null;

  const send = vi.fn(async (command: unknown): Promise<unknown> => {
    if (failure) {
      throw new Error(failure);
    }

    const cmd = command as {
      constructor: { name: string };
      input?: {
        Bucket?: string;
        Key?: string;
        Body?: Buffer | string;
        ContentType?: string;
        Prefix?: string;
      };
    };

    const commandName = cmd.constructor?.name || 'Unknown';

    switch (commandName) {
      case 'PutObjectCommand': {
        const key = `${cmd.input?.Bucket}:${cmd.input?.Key}`;
        objects.set(key, {
          key: cmd.input?.Key || '',
          body: cmd.input?.Body || Buffer.from(''),
          contentType: cmd.input?.ContentType,
        });
        return { $metadata: { httpStatusCode: 200 } };
      }

      case 'GetObjectCommand': {
        const key = `${cmd.input?.Bucket}:${cmd.input?.Key}`;
        const obj = objects.get(key);
        if (!obj) {
          const err = new Error('NoSuchKey');
          (err as Error & { Code: string }).Code = 'NoSuchKey';
          throw err;
        }
        return {
          Body: {
            transformToByteArray: async () =>
              obj.body instanceof Buffer ? obj.body : Buffer.from(obj.body),
          },
          ContentType: obj.contentType,
        };
      }

      case 'DeleteObjectCommand': {
        const key = `${cmd.input?.Bucket}:${cmd.input?.Key}`;
        objects.delete(key);
        return { $metadata: { httpStatusCode: 204 } };
      }

      case 'ListObjectsV2Command': {
        const prefix = cmd.input?.Prefix || '';
        const bucket = cmd.input?.Bucket || '';
        const matching = Array.from(objects.entries())
          .filter(([k]) => k.startsWith(`${bucket}:${prefix}`))
          .map(([, obj]) => ({
            Key: obj.key,
            Size: typeof obj.body === 'string' ? obj.body.length : obj.body.length,
            LastModified: new Date(),
          }));
        return { Contents: matching, IsTruncated: false };
      }

      default:
        return { $metadata: { httpStatusCode: 200 } };
    }
  });

  return {
    send,
    objects,
    clear: () => {
      objects.clear();
      send.mockClear();
    },
    addObject: (bucket: string, obj: MockS3Object) => {
      objects.set(`${bucket}:${obj.key}`, obj);
    },
    setFailure: (error: string | null) => {
      failure = error;
    },
  };
}
