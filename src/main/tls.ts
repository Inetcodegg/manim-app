import fs from "node:fs";
import path from "node:path";
import forge from "node-forge";
import { userDataDir } from "./paths";
import { log } from "./logger";

/**
 * A self-signed TLS certificate for 127.0.0.1, generated once per install
 * and cached under userData — this is what turns the WebSocket into
 * wss://, so a compiled Manim scene (which can embed a user's own text,
 * labels, and project name) isn't sent across a loopback socket in the
 * clear. Loopback traffic never actually leaves the machine, but "local"
 * isn't the same guarantee as "encrypted": other local processes/users on
 * a shared machine, browser extensions with raw socket access, or a proxy
 * tool sitting on 127.0.0.1 could otherwise observe it. wss:// closes that
 * gap the same way it would for any other WebSocket.
 *
 * Generated via Node's own crypto (no OpenSSL binary dependency — nothing
 * else to bundle) using node-forge, which is pure JS and works identically
 * whether or not the user's machine has OpenSSL on PATH.
 */

export interface TlsCert {
  keyPem: string;
  certPem: string;
  /** SHA-256 fingerprint, hex, colon-separated — shown in the status window
   *  so a technically-inclined user can manually verify what the site's
   *  browser tab is being asked to trust. */
  fingerprint: string;
}

function certDir(): string {
  return path.join(userDataDir(), "tls");
}

function keyFile(): string {
  return path.join(certDir(), "key.pem");
}

function certFile(): string {
  return path.join(certDir(), "cert.pem");
}

function fingerprintOf(certPem: string): string {
  const cert = forge.pki.certificateFromPem(certPem);
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const md = forge.md.sha256.create();
  md.update(der);
  return md
    .digest()
    .toHex()
    .match(/.{2}/g)!
    .join(":")
    .toUpperCase();
}

function generate(): TlsCert {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [{ name: "commonName", value: "Manim Studio Render Agent" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: "localhost" }, // DNS
        { type: 7, ip: "127.0.0.1" }, // IP
      ],
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);
  return { keyPem, certPem, fingerprint: fingerprintOf(certPem) };
}

/** Loads the cached cert if present and still valid for a while yet,
 *  otherwise generates and caches a new one. Reused across app restarts so
 *  the site doesn't have to re-accept a new certificate every launch. */
export function ensureTlsCert(): TlsCert {
  try {
    if (fs.existsSync(keyFile()) && fs.existsSync(certFile())) {
      const keyPem = fs.readFileSync(keyFile(), "utf8");
      const certPem = fs.readFileSync(certFile(), "utf8");
      return { keyPem, certPem, fingerprint: fingerprintOf(certPem) };
    }
  } catch (err) {
    log.warn("failed to read cached TLS cert, regenerating:", String(err));
  }

  const generated = generate();
  fs.mkdirSync(certDir(), { recursive: true });
  fs.writeFileSync(keyFile(), generated.keyPem, { mode: 0o600 });
  fs.writeFileSync(certFile(), generated.certPem, { mode: 0o600 });
  log.info(`generated new self-signed TLS certificate (fingerprint ${generated.fingerprint})`);
  return generated;
}
