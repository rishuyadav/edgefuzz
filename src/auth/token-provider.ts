/**
 * Auth Token Provider
 *
 * Executes a user-supplied shell command to obtain a bearer token,
 * caches it, and re-runs automatically on 401 responses (once per run).
 *
 * Accepts two output formats from the command:
 *   - Plain string:     the token itself (e.g. `echo $MY_API_KEY`)
 *   - JSON object:      must have a "token" or "access_token" field
 *                       (e.g. `curl -s .../token | jq .access_token`)
 *
 * Concurrency safety:
 *   When many requests complete with 401 simultaneously, only ONE refresh
 *   command is executed. All other callers await the same refresh promise
 *   rather than spawning competing subprocesses.
 *
 * Usage:
 *   const provider = new TokenProvider('curl -s -X POST .../oauth/token -d "..."');
 *   await provider.getToken();           // "eyJ..."  (fetched on first call)
 *   await provider.handleUnauthorized(); // re-runs once, returns new token
 */

import { execSync } from 'child_process';

export class TokenProvider {
  private readonly command: string;
  private cachedToken: string | null = null;

  /**
   * Tracks a pending initial-fetch or refresh so concurrent callers
   * all await the same operation rather than running the command N times.
   */
  private pendingFetch: Promise<string> | null = null;

  /**
   * Set to true after the first successful refresh to prevent a second one.
   * A session refreshes at most once: repeated 401s after a successful refresh
   * indicate a misconfigured token command, not token expiry.
   */
  private refreshed = false;

  constructor(command: string) {
    this.command = command;
  }

  /**
   * Return the cached token (fetching it on first call).
   * Thread-safe: concurrent calls share a single pending fetch.
   */
  async getToken(): Promise<string> {
    if (this.cachedToken !== null) return this.cachedToken;

    // If a fetch is already in flight, piggyback on it
    if (this.pendingFetch !== null) return this.pendingFetch;

    this.pendingFetch = this.runCommand().then((token) => {
      this.cachedToken = token;
      this.pendingFetch = null;
      return token;
    });

    return this.pendingFetch;
  }

  /**
   * Called when the server returns 401.
   * Re-runs the auth command at most once per session to handle token expiry.
   * Concurrent callers all await the same refresh promise — only one subprocess
   * is spawned regardless of how many 401s arrive simultaneously.
   *
   * Returns the new token, or null if a refresh already happened (no-op).
   */
  async handleUnauthorized(): Promise<string | null> {
    if (this.refreshed) return this.cachedToken;

    // If a refresh is already underway (another concurrent 401 started it),
    // wait for it instead of spawning a duplicate subprocess.
    if (this.pendingFetch !== null) return this.pendingFetch;

    this.refreshed = true;
    this.cachedToken = null; // clear stale token before refresh

    this.pendingFetch = this.runCommand().then((token) => {
      this.cachedToken = token;
      this.pendingFetch = null;
      return token;
    });

    return this.pendingFetch;
  }

  /**
   * Returns the Authorization header value to inject.
   * Fetches the token if not already cached.
   */
  async getAuthHeader(): Promise<string> {
    const token = await this.getToken();
    // Avoid double-prefixing when the command already returns "Bearer <token>"
    return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async runCommand(): Promise<string> {
    let output: string;
    try {
      output = execSync(this.command, {
        encoding: 'utf-8',
        timeout: 30_000, // 30s max — auth commands should be fast
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Auth command failed: ${msg}\n` +
        `Command: ${this.command}\n` +
        `Tip: Test it manually in your terminal to verify it outputs a token.`,
      );
    }

    if (!output) {
      throw new Error(
        `Auth command produced no output.\n` +
        `Command: ${this.command}\n` +
        `Tip: The command must print a token (plain string or JSON with "token"/"access_token" field) to stdout.`,
      );
    }

    // Try JSON first
    if (output.startsWith('{') || output.startsWith('[')) {
      try {
        const parsed = JSON.parse(output) as Record<string, unknown>;
        const token =
          (parsed['token'] as string | undefined) ??
          (parsed['access_token'] as string | undefined) ??
          (parsed['accessToken'] as string | undefined) ??
          (parsed['Bearer'] as string | undefined);

        if (token && typeof token === 'string') return token;

        throw new Error(
          `Auth command returned JSON but no "token" or "access_token" field was found.\n` +
          `Got keys: ${Object.keys(parsed).join(', ')}\n` +
          `Command: ${this.command}`,
        );
      } catch (e) {
        if ((e as Error).message.includes('Auth command')) throw e;
        // JSON parse failed — fall through and treat as plain string
      }
    }

    // Treat as plain bearer token; strip surrounding quotes if any
    return output.replace(/^["']|["']$/g, '');
  }
}
