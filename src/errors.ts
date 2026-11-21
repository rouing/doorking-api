// An Error carrying the HTTP status the server answers with (web/requests.ts reads `status`; 400 when there is none).
export type HttpError = Error & { status: number };

export const httpError = (message: string, status = 400): HttpError => Object.assign(new Error(message), { status });
