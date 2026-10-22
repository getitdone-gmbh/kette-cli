import os from 'node:os';
import path from 'node:path';

// Everything of Die Kette lives in ~/.kette, overridable for tests and company installs
export const home = () => process.env.KETTE_HOME || path.join(os.homedir(), '.kette');
export const bundlesDir = () => path.join(home(), 'bundles');
export const activeBundleLink = () => path.join(bundlesDir(), 'active');
export const credentialsFile = () => path.join(home(), 'credentials');
export const deviceIdFile = () => path.join(home(), 'device-id');
export const stateFile = () => path.join(home(), 'state.json');
export const mirror = () => (process.env.KETTE_MIRROR || 'https://kette.itdone.de/dl').replace(/\/$/, '');
export const delivery = () => (process.env.KETTE_DELIVERY || 'https://app-kette-delivery-833790b5.itdone.cloud').replace(/\/$/, '');
// User npmrc the way npm finds it: NPM_CONFIG_USERCONFIG, otherwise ~/.npmrc
export const npmUserConfig = () => process.env.NPM_CONFIG_USERCONFIG || process.env.npm_config_userconfig || path.join(os.homedir(), '.npmrc');
// Registry of the design system packages; the delivery service names it at login, this is only the default
export const registryDefault = () => (process.env.KETTE_REGISTRY || 'https://npm.kette.itdone.de/').replace(/\/?$/, '/');
