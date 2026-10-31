import os from 'node:os';
import path from 'node:path';

// Everything of Die Kette lives in ~/.kette, overridable for tests and company installs
export const home = () => process.env.KETTE_HOME || path.join(os.homedir(), '.kette');
export const bundlesDir = () => path.join(home(), 'bundles');
export const activeBundleLink = () => path.join(bundlesDir(), 'active');
export const credentialsFile = () => path.join(home(), 'credentials');
export const deviceIdFile = () => path.join(home(), 'device-id');
export const stateFile = () => path.join(home(), 'state.json');
// One folder per Kette instance, each holds instance.json (a plain folder, a git clone or a link to an instance repo)
export const instancesDir = () => path.join(home(), 'instances');
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
// https everywhere; plain http only for a local test server or with KETTE_INSECURE=1
export function isSecureUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && (LOCAL_HOSTS.includes(u.hostname) || process.env.KETTE_INSECURE === '1');
}
export function secureUrl(url, name) {
  if (!isSecureUrl(url)) throw new Error(`${name} must be an https URL: ${url}. Plain http only for a trusted test server with KETTE_INSECURE=1.`);
  return url;
}
export const mirror = () => secureUrl((process.env.KETTE_MIRROR || 'https://kette.itdone.de/dl').replace(/\/$/, ''), 'KETTE_MIRROR');
export const delivery = () => secureUrl((process.env.KETTE_DELIVERY || 'https://app-kette-delivery-833790b5.itdone.cloud').replace(/\/$/, ''), 'KETTE_DELIVERY');
// User npmrc the way npm finds it: NPM_CONFIG_USERCONFIG, otherwise ~/.npmrc
export const npmUserConfig = () => process.env.NPM_CONFIG_USERCONFIG || process.env.npm_config_userconfig || path.join(os.homedir(), '.npmrc');
// Registry of the design system packages; the delivery service names it at login, this is only the default
export const registryDefault = () => secureUrl((process.env.KETTE_REGISTRY || 'https://npm.kette.itdone.de/').replace(/\/?$/, '/'), 'KETTE_REGISTRY');
