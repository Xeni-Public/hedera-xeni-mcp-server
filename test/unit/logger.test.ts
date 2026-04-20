// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Unit tests for `src/logger.ts` — validates the level gating, formatting,
 * and stderr routing.
 *
 * Integration tests (`test/integration/server.test.ts`) exercise `log.info`
 * and `log.warn` via the server bootstrap path, so this file focuses on:
 *   - the debug path (never fires at default LOG_LEVEL=info)
 *   - the error path (not reached by happy-path integration tests)
 *   - LOG_LEVEL env parsing (debug/info/warn/error explicit values, unknown
 *     falls back to info)
 *   - the format helper's behavior with/without context and empty context
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../src/logger.js';

describe('logger', () => {
  const savedLevel = process.env['LOG_LEVEL'];
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env['LOG_LEVEL'];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    if (savedLevel !== undefined) process.env['LOG_LEVEL'] = savedLevel;
    else delete process.env['LOG_LEVEL'];
    stderrSpy.mockRestore();
  });

  describe('level gating', () => {
    it('does NOT emit debug at default level (info)', () => {
      log.debug('hidden debug line');
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('emits debug when LOG_LEVEL=debug', () => {
      process.env['LOG_LEVEL'] = 'debug';
      log.debug('visible debug line');
      expect(stderrSpy).toHaveBeenCalledOnce();
      const out = String(stderrSpy.mock.calls[0]?.[0]);
      expect(out).toContain('[DEBUG]');
      expect(out).toContain('visible debug line');
    });

    it('emits warn at default level', () => {
      log.warn('warn line');
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(String(stderrSpy.mock.calls[0]?.[0])).toContain('[WARN]');
    });

    it('emits error at default level', () => {
      log.error('error line');
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(String(stderrSpy.mock.calls[0]?.[0])).toContain('[ERROR]');
    });

    it('suppresses info when LOG_LEVEL=warn', () => {
      process.env['LOG_LEVEL'] = 'warn';
      log.info('should be hidden');
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('suppresses warn when LOG_LEVEL=error', () => {
      process.env['LOG_LEVEL'] = 'error';
      log.warn('should be hidden');
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('falls back to info when LOG_LEVEL is unknown', () => {
      process.env['LOG_LEVEL'] = 'verbose'; // not a valid level
      log.info('should still print');
      log.debug('should NOT print');
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(String(stderrSpy.mock.calls[0]?.[0])).toContain('[INFO]');
    });

    it('accepts LOG_LEVEL case-insensitively', () => {
      process.env['LOG_LEVEL'] = 'DEBUG';
      log.debug('case-insensitive');
      expect(stderrSpy).toHaveBeenCalledOnce();
    });
  });

  describe('formatting', () => {
    it('emits `[<iso>] [LEVEL] message` when no context is given', () => {
      log.info('naked message');
      const out = String(stderrSpy.mock.calls[0]?.[0]);
      // Matches ISO 8601 UTC timestamp prefix
      expect(out).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[INFO\] naked message\n$/,
      );
    });

    it('appends `key=value` pairs when context has entries', () => {
      log.info('with ctx', { tool: 'transfer_hbar', correlationId: 'abc-123' });
      const out = String(stderrSpy.mock.calls[0]?.[0]);
      expect(out).toContain('with ctx');
      expect(out).toContain('tool="transfer_hbar"');
      expect(out).toContain('correlationId="abc-123"');
    });

    it('treats an empty context object like no context (no trailing space)', () => {
      log.info('empty ctx', {});
      const out = String(stderrSpy.mock.calls[0]?.[0]);
      // No trailing "key=value" segment; newline terminates the message directly.
      expect(out).toMatch(/\] empty ctx\n$/);
    });

    it('JSON-encodes non-string context values', () => {
      log.info('mixed', { count: 42, ok: true, nothing: null });
      const out = String(stderrSpy.mock.calls[0]?.[0]);
      expect(out).toContain('count=42');
      expect(out).toContain('ok=true');
      expect(out).toContain('nothing=null');
    });
  });

  describe('stderr routing', () => {
    it('writes to stderr (never stdout — stdout is reserved for MCP JSON-RPC)', () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      log.info('stderr only');
      log.warn('stderr only');
      log.error('stderr only');
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledTimes(3);
      stdoutSpy.mockRestore();
    });
  });
});
