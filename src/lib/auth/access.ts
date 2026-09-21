import { cookies } from "next/headers";
import {
  AccessService,
  HouseholdProfileService,
  isAccessError,
} from "thesidedoor-core/access";
import { createAccessHandler } from "thesidedoor-core/access/http";
import { dataRoot } from "../data-dir";
import { PapernookIdentityStore } from "./identity-store";
import { profileCapability } from "./profile-capability";
import { accessOrigins } from "./platform/configuration";

export const ACCESS_COOKIE = "papernook_access";
let instance:
  | {
      directory: string;
      identity: PapernookIdentityStore;
      access: AccessService;
      profiles: HouseholdProfileService;
    }
  | undefined;

export function sharedAccess() {
  const directory = dataRoot();
  if (instance?.directory === directory) return instance;
  const identity = new PapernookIdentityStore(directory);
  const access = new AccessService({
    store: identity.accessStore(),
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    householdSessionTtlMs: 7 * 24 * 60 * 60 * 1000,
  });
  instance = {
    directory,
    identity,
    access,
    profiles: new HouseholdProfileService(access),
  };
  return instance;
}

export async function requestIdentity(suppliedToken?: string) {
  const token = suppliedToken ?? (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) return null;
  const { identity, access, profiles } = sharedAccess();
  const state = await identity.read();
  try {
    const authenticated = access.sessionFromState(state.access, token);
    const username = authenticated.principal
      ? state.bindings[authenticated.principal.id]
      : profiles.selectedFromState(state.access, token)?.id;
    const profile =
      state.profiles.find((entry) => entry.username === username) ?? null;
    const capability = profile
      ? profileCapability(state, profile.username)
      : null;
    return { ...authenticated, profile, capability, token };
  } catch (error) {
    if (
      isAccessError(error) &&
      (error.code === "unauthorized" || error.code === "forbidden")
    )
      return null;
    throw error;
  }
}

export async function currentOwner(): Promise<boolean> {
  return (await requestIdentity())?.principal?.role === "owner";
}

export function accessFailure(error: unknown): Response {
  if (isAccessError(error)) {
    const statuses = {
      unauthorized: 401,
      forbidden: 403,
      invalid: 400,
      rate_limited: 429,
      conflict: 409,
    };
    return Response.json(
      { error: error.message, code: error.code },
      { status: statuses[error.code] },
    );
  }
  return Response.json(
    { error: "Access storage is unavailable. Retry shortly." },
    { status: 503 },
  );
}

export function accessHandler() {
  const { access, profiles } = sharedAccess();
  const origins = accessOrigins();
  const trustedProxy = new URL(origins.canonicalOrigin).protocol === "https:";
  return createAccessHandler({
    access,
    profiles,
    name: "papernook",
    origin: origins.canonicalOrigin,
    passwordOrigins: origins.passwordOrigins,
    trustedProxy,
    useHostHeader: true,
    allowOriginlessJsonClients: true,
    cookieName: ACCESS_COOKIE,
  });
}
