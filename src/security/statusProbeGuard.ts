/**
 * Guard for manifest-declared status probe URLs.
 *
 * Manifest metadata.statusCheck endpoints let a third-party manifest drive the
 * host to issue arbitrary HTTP requests. This guard applies a default-deny
 * policy: a probe target is only allowed when it matches the extension's own
 * artifact endpoint host, is a loopback address, or is explicitly allow-listed
 * by the host application via `statusProbeAllowedHosts`.
 */

export function normalizeHostname(hostname: string): string {
  return hostname.trim().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase()
}

export function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHostname(hostname)

  if (host === 'localhost' || host === '::1') {
    return true
  }

  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

export function isPrivateNetworkHost(hostname: string): boolean {
  const host = normalizeHostname(hostname)

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const octets = [ipv4[1], ipv4[2], ipv4[3], ipv4[4]].map((value) => Number.parseInt(value, 10))
    if (octets.some((value) => value > 255)) {
      return false
    }

    const [first, second] = octets

    // 10.0.0.0/8
    if (first === 10) {
      return true
    }
    // 172.16.0.0/12
    if (first === 172 && second >= 16 && second <= 31) {
      return true
    }
    // 192.168.0.0/16
    if (first === 192 && second === 168) {
      return true
    }
    // 169.254.0.0/16 (link-local)
    if (first === 169 && second === 254) {
      return true
    }

    return false
  }

  if (host.includes(':')) {
    // fd00::/8 (unique local addresses)
    const firstHextet = host.split(':')[0]
    if (firstHextet.length > 0) {
      const value = Number.parseInt(firstHextet, 16)
      if (!Number.isNaN(value) && value >= 0xfd00 && value <= 0xfdff) {
        return true
      }
    }
  }

  return false
}

export function assertStatusProbeAllowed(
  url: string,
  ownEndpoint: string | undefined,
  allowedHosts: string[],
): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Status probe URL is not a valid URL: ${url}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Status probe URL must use http or https: ${url}`)
  }

  const host = normalizeHostname(parsed.hostname)

  if (ownEndpoint) {
    try {
      const own = new URL(ownEndpoint)
      if (normalizeHostname(own.hostname) === host) {
        return
      }
    } catch {
      // A non-URL own endpoint cannot grant the same-host allowance.
    }
  }

  if (isLoopbackHost(host)) {
    return
  }

  if (allowedHosts.map(normalizeHostname).includes(host)) {
    return
  }

  if (isPrivateNetworkHost(host)) {
    throw new Error(`Status probe host not allowed: ${host} (private/internal network address). Add the host to statusProbeAllowedHosts to allow probing it.`)
  }

  throw new Error(`Status probe host not allowed: ${host}. Add the host to statusProbeAllowedHosts to allow probing it.`)
}
