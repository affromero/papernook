import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const helper = path.resolve(
  import.meta.dirname,
  "../../../scripts/install-env.sh",
);

function run(functionName: string, value: string) {
  return spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; "$2" "$3"',
      "papernook-installer-test",
      helper,
      functionName,
      value,
    ],
    { encoding: "utf8" },
  );
}

describe("installer environment values", () => {
  it("single-quotes Compose-sensitive password characters", () => {
    expect(run("dotenv_quote", "correct$horse#battery staple").stdout).toBe(
      "'correct$horse#battery staple'",
    );
    expect(run("dotenv_quote", "correct'horse$money").stdout).toBe(
      "'correct\\'horse$money'",
    );
    expect(run("dotenv_quote", "correcthorse12\\").stdout).toBe(
      "'correcthorse12\\\\'",
    );
    expect(run("dotenv_quote", "correct\\'horse123").stdout).toBe(
      "'correct\\\\\\'horse123'",
    );
  });

  it("matches the access gate's supported password length", () => {
    expect(run("validate_papernook_password", "a".repeat(15)).status).toBe(1);
    expect(run("validate_papernook_password", "a".repeat(16)).status).toBe(0);
    expect(run("validate_papernook_password", "a".repeat(200)).status).toBe(0);
    expect(run("validate_papernook_password", "a".repeat(201)).status).toBe(1);
  });

  it("accepts only usable public WebDAV HTTPS URLs", () => {
    expect(
      run("validate_public_webdav_url", "https://dav-papernook.example.com")
        .status,
    ).toBe(0);
    expect(
      run(
        "validate_public_webdav_url",
        "https://storage.example.com:8443/papers",
      ).status,
    ).toBe(0);

    for (const value of [
      "http://dav.example.com",
      "https://.",
      "https://dav.example.com:abc",
      "https://dav.example.com:65536",
      "https://user@dav.example.com",
      "https://dav.example.com/papers?token=value",
      "https://-dav.example.com",
    ]) {
      expect(run("validate_public_webdav_url", value).status, value).toBe(1);
    }
  });
});
