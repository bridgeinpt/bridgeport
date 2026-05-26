import { describe, it, expect } from 'vitest';
import { detectLanguage } from './config-file-language.js';

describe('detectLanguage', () => {
  describe('extension mapping', () => {
    it('maps .yml to yaml', () => {
      expect(detectLanguage('docker-compose.yml')).toBe('yaml');
    });

    it('maps .yaml to yaml', () => {
      expect(detectLanguage('app.yaml')).toBe('yaml');
    });

    it('maps .json to json', () => {
      expect(detectLanguage('config.json')).toBe('json');
    });

    it('maps .env to env', () => {
      expect(detectLanguage('app.env')).toBe('env');
    });

    it('maps .toml to toml', () => {
      expect(detectLanguage('pyproject.toml')).toBe('toml');
    });

    it('maps .ini to ini', () => {
      expect(detectLanguage('php.ini')).toBe('ini');
    });

    it('maps .conf to conf', () => {
      expect(detectLanguage('app.conf')).toBe('conf');
    });

    it('maps .cnf to conf', () => {
      expect(detectLanguage('my.cnf')).toBe('conf');
    });

    it('maps .sh to sh', () => {
      expect(detectLanguage('start.sh')).toBe('sh');
    });

    it('maps .bash to sh', () => {
      expect(detectLanguage('script.bash')).toBe('sh');
    });

    it('maps .zsh to sh', () => {
      expect(detectLanguage('script.zsh')).toBe('sh');
    });

    it('maps .dockerfile to dockerfile', () => {
      expect(detectLanguage('app.dockerfile')).toBe('dockerfile');
    });
  });

  describe('exact-name shortcuts', () => {
    it('detects Dockerfile by exact name', () => {
      expect(detectLanguage('Dockerfile')).toBe('dockerfile');
    });

    it('detects Caddyfile by exact name and maps to nginx', () => {
      expect(detectLanguage('Caddyfile')).toBe('nginx');
    });

    it('detects nginx.conf by exact name and maps to nginx', () => {
      expect(detectLanguage('nginx.conf')).toBe('nginx');
    });

    it('detects Makefile by exact name and maps to plaintext', () => {
      expect(detectLanguage('Makefile')).toBe('plaintext');
    });

    it('prefers exact-name match over extension', () => {
      // nginx.conf is in EXACT_NAME_MAP -> nginx, but .conf normally maps to 'conf'
      expect(detectLanguage('nginx.conf')).toBe('nginx');
    });
  });

  describe('dotfile shortcuts', () => {
    it('treats .env as env', () => {
      expect(detectLanguage('.env')).toBe('env');
    });

    it('treats .env.production as env', () => {
      expect(detectLanguage('.env.production')).toBe('env');
    });

    it('treats .env.local as env', () => {
      expect(detectLanguage('.env.local')).toBe('env');
    });
  });

  describe('case handling', () => {
    it('lower-cases the extension before lookup', () => {
      expect(detectLanguage('CONFIG.JSON')).toBe('json');
      expect(detectLanguage('App.YML')).toBe('yaml');
      expect(detectLanguage('Script.SH')).toBe('sh');
    });

    it('exact-name matches are case-sensitive (Dockerfile only)', () => {
      // Exact-name map uses 'Dockerfile' — lowercase 'dockerfile' falls through
      // to the extension lookup which DOES include 'dockerfile' -> 'dockerfile'.
      expect(detectLanguage('Dockerfile')).toBe('dockerfile');
      // 'dockerfile' (lowercase, no extension) has no extension and no
      // exact-name entry, so it should resolve to plaintext.
      expect(detectLanguage('dockerfile')).toBe('plaintext');
    });
  });

  describe('unknown / edge cases', () => {
    it('returns plaintext for unknown extensions', () => {
      expect(detectLanguage('readme.txt')).toBe('plaintext');
      expect(detectLanguage('notes.md')).toBe('plaintext');
      expect(detectLanguage('foo.xyz')).toBe('plaintext');
    });

    it('returns plaintext for files without extension', () => {
      expect(detectLanguage('README')).toBe('plaintext');
      expect(detectLanguage('LICENSE')).toBe('plaintext');
    });

    it('returns plaintext for empty input', () => {
      expect(detectLanguage('')).toBe('plaintext');
    });

    it('strips directory paths and uses basename', () => {
      expect(detectLanguage('/etc/nginx/nginx.conf')).toBe('nginx');
      expect(detectLanguage('configs/app.yml')).toBe('yaml');
      expect(detectLanguage('C:\\path\\to\\Dockerfile')).toBe('dockerfile');
    });
  });
});
