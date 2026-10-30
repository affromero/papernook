import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export async function sharingGateway(dataDir) {
  const directory = path.join(dataDir, "sharing-tls");
  fs.mkdirSync(directory, { recursive: true });
  const key = path.join(directory, "key.pem");
  const cert = path.join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "pipe" },
  );
  const server = https.createServer(
    { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
    (request, response) => {
      if (
        !/^\/api\/v1\/shares\/[a-z0-9-]+\/[a-z0-9-]+\/[a-f0-9]{64}\/exchange$/.test(
          request.url ?? "",
        )
      ) {
        response.writeHead(404).end();
        return;
      }
      const proxy = http.request(
        {
          host: "127.0.0.1",
          port: 3107,
          path: request.url,
          method: request.method,
          headers: { ...request.headers, host: "127.0.0.1:3107" },
        },
        (upstream) => {
          response.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(response);
        },
      );
      proxy.on("error", () => response.writeHead(502).end());
      request.pipe(proxy);
    },
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(3148, "127.0.0.1", resolve);
  });
  return { server, cert, origin: "https://127.0.0.1:3148" };
}
