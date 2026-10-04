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
 * Usage:
 *   const provider = new TokenProvider('curl -s -X POST .../oauth/token -d "..."');
 *   const token = await provider.getToken();   // "Bearer eyJ..."
 *   await provider.handleUnauthorized();       // re-runs command, refreshes cache
 */

import { execSync } from 'child_process';

export class TokenProvider {
  private readonly command: string;
  private cachedToken: string | null = null;
  private refreshed = false;

  constructor(command: string) {
    this.command = command;
  }

  /**
   * Return the cached token (fetching it on first call).
   * Returns the token string without the "Bearer " prefix.
   */
  async getToken(): Promise<string> {
    if (this.cachedToken === null) {
      this.cachedToken = await this.runCommand();
    }
    return this.cachedToken;
  }

  /**
   * Called when the server returns 401.
   * Re-runs the auth command once per session to handle token expiry.
   * Subsequent calls within the same run are no-ops.
   */
  async handleUnauthorized(): Promise<string | null> {
    if (this.refreshed) return this.cachedToken;
    this.refreshed = true;
    this.cachedToken = await this.runCommand();
    return this.cachedToken;
  }

  /**
   * Returns the Authorization header value to inject.
   * Fetches the token if not already cached.
   */
  async getAuthHeader(): Promise<string> {
    const token = await this.getToken();
    // If the token already starts with "Bearer " don't double-prefix it
    return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
  }

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

    // Treat as plain bearer token
    // Strip surrounding quotes if the shell command returns a quoted string
    return output.replace(/^["']|["']$/g, '');
  }
}
