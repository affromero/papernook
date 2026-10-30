import { requestIdentity, sharedAccess } from "../../auth/access";
import { withProfileFiles } from "../../auth/profile-capability";
import { listProfiles } from "../../auth/users";
import { listShares } from "../../library/shares";
import { SharingError } from "../protocol/values";
import type { ArtifactActor, ArtifactCommit } from "./source";

export function hasCollaboration(topic: string, slug: string): boolean {
  return listProfiles().some((profile) =>
    listShares(topic, slug, profile.username).some(
      (share) => share.mode === "collaborate" && !share.revoked,
    ),
  );
}

export async function localArtifactAuthority(): Promise<{
  actor: ArtifactActor;
  commit: ArtifactCommit;
}> {
  const identity = await requestIdentity();
  if (!identity?.profile || !identity.capability)
    throw new SharingError("Not signed in.", 401);
  const capability = identity.capability;
  return {
    actor: {
      id: `profile:${capability.username}:${capability.generation}`,
      name: identity.profile.displayName,
    },
    commit: (operation) =>
      withProfileFiles(sharedAccess().identity, capability, operation),
  };
}
