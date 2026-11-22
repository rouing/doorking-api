/**
 * An Error carrying the HTTP status the server answers with (web/requests.ts reads `status`; 400 when there is none).
 */
export type HttpError = Error & { status: number };

/**
 * Http error.
 *
 * @param message - Message text.
 * @param [status] - HTTP status code or relay status string.
 * @returns `HttpError` result.
 */
export const httpError = (message: string, status = 400): HttpError => Object.assign(new Error(message), { status });

/**
 * A passkey answer for a passkey the server doesn't know (removed, or made on another site name). 401; the sign-in
 * route also says so, so the page can tell the browser to stop offering it.
 */
export class UnknownPasskeyError extends Error {
  readonly status = 401;
}
