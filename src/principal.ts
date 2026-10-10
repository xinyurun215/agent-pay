import { HttpError } from "./errors.js";

/** Bound subject for the demo USER_TOKEN when DEMO_PRINCIPAL is unset. */
export const DEFAULT_DEMO_PRINCIPAL = "demo:office-user";

/**
 * Principal for the authenticated demo user.
 * An empty or unset value uses the default. The client cannot choose this.
 */
export function resolveDemoPrincipal(raw: string | undefined): string {
  const principal = raw?.trim() || DEFAULT_DEMO_PRINCIPAL;
  if (principal.length > 120) {
    throw new Error("DEMO_PRINCIPAL must be 1 to 120 characters");
  }
  return principal;
}

/** Confirm must not take a client subject. The server binds principal from USER_TOKEN. */
export function rejectClientPrincipal(body: unknown): void {
  if (typeof body === "object" && body !== null && "principal" in body) {
    throw new HttpError(
      400,
      "principal_not_accepted",
      "principal is bound to the authenticated USER_TOKEN and is not accepted in the request body",
    );
  }
}
