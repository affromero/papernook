import { redirect } from "next/navigation";
import { isAccessError } from "thesidedoor-core/access";
import { sharedAccess } from "../access";
import {
  withProfileFiles,
  type ProfileCapability,
} from "../profile-capability";

/** Read private page data using the identity admitted before any awaits. */
export function profilePageFiles<Result>(
  capability: ProfileCapability,
  operation: () => Result &
    (Result extends PromiseLike<unknown> ? never : unknown),
): Result {
  try {
    return withProfileFiles(sharedAccess().identity, capability, operation);
  } catch (error) {
    if (isAccessError(error) && error.code === "unauthorized")
      redirect("/login");
    throw error;
  }
}
