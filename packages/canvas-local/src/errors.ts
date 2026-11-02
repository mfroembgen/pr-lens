export class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}
export const notFound = () => new Refusal(404, "NOT_FOUND", "No canvas with that id, or access is unavailable");
export const liveEnded = () => new Refusal(404, "LIVE_ENDED", "That live session has ended; open another session");
export const invalid = (message: string) => new Refusal(400, "INVALID_REQUEST", message);
